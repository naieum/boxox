import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { BoxOx, verifyWebhook } from "@boxox/mail";
import { run, listen } from "../dist/cli.js";
import { normalizeUrl } from "../dist/credentials.js";
import { startLocal } from "./local.mjs";

let local, dir, domainKey, domainId, hook;
const exec = promisify(execFile);
const original = { ...process.env };
async function command(args, key = domainKey) {
  process.env.BOXOX_URL = local.url; process.env.BOXOX_KEY = key;
  const values = []; await run(args, { output: (v) => values.push(v) }); return values;
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "boxox-cli-"));
  process.env.BOXOX_CONFIG_DIR = dir;
  local = await startLocal();
  const [created] = await command(["keys", "create", "--domain", "app.test", "--perm", "send", "--perm", "read_log", "--perm", "templates", "--perm", "webhooks"], local.management.secret);
  domainKey = created.secret; domainId = created.key.id;
}, { timeout: 60000 });
after(async () => {
  await local?.worker.stop(); if (dir) await rm(dir, { recursive: true, force: true });
  for (const name of ["BOXOX_URL", "BOXOX_KEY", "BOXOX_CONFIG_DIR"]) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
});

test("login saves only origin to config and delegates secret to the keychain", async () => {
  let saved;
  await run(["login", "--url", local.url + "/", "--key", domainKey], { keychain: { set: async (...args) => { saved = args; }, get: async () => domainKey }, output: () => {} });
  assert.deepEqual(saved, [local.url, domainKey]);
  const config = await readFile(join(dir, "config.json"), "utf8");
  assert.deepEqual(JSON.parse(config), { url: local.url }); assert.ok(!config.includes(domainKey));
  assert.throws(() => normalizeUrl("http://remote.test"), /HTTPS/);
  assert.throws(() => normalizeUrl("https://user:secret@remote.test"), /credentials/);
});
test("keys list, rotate and revoke enforce management auth against Wrangler", async () => {
  const [list] = await command(["keys", "list"], local.management.secret);
  assert.ok(list.data.some((key) => key.id === domainId));
  await assert.rejects(command(["keys", "list"]), /management key/i);
  const [created] = await command(["keys", "create", "--domain", "app.test", "--perm", "send"], local.management.secret);
  const [rotated] = await command(["keys", "rotate", created.key.id, "--overlap-hours", "0"], local.management.secret);
  assert.notEqual(rotated.secret, created.secret);
  await assert.rejects(command(["doctor"], created.secret), /valid API key/);
  await command(["keys", "revoke", created.key.id], local.management.secret);
  await assert.rejects(command(["doctor"], rotated.secret), /valid API key/);
});
test("send, idempotency, list/get/tail and domain isolation use real stored messages", async () => {
  const args = ["send", "--from", "hello@app.test", "--to", "reader@example.test", "--subject", "Local command test", "--text", "hello", "--idempotency-key", "cli-test"];
  const [sent] = await command(args); const [replayed] = await command(args);
  assert.equal(sent.status, "queued"); assert.equal(sent.id, replayed.id);
  const [listed] = await command(["messages", "list", "--recipient", "reader@example.test"]);
  assert.ok(listed.data.some((m) => m.id === sent.id));
  const [detail] = await command(["messages", "get", sent.id]); assert.equal(detail.subject, "Local command test");
  const tail = await command(["messages", "tail", "--once", "--limit", "1"]); assert.ok(tail.some((m) => m.id === sent.id));
  await assert.rejects(command(["send", "--from", "hello@other.test", "--to", "reader@example.test", "--subject", "no", "--text", "no"]), /domain|From/i);
});
test("template push creates then versions; pull round-trips; preview escapes variables", async () => {
  const file = join(dir, "welcome.json");
  const source = { name: "welcome", subject: "Hello {{name}}", html: "<p>{{name}}</p>", variables: [{ name: "name", type: "string", raw: false }] };
  await writeFile(file, JSON.stringify(source));
  await command(["templates", "push", file]);
  const [preview] = await command(["templates", "preview", "welcome", "--variables", '{"name":"<script>"}']);
  assert.equal(preview.html, "<p>&lt;script&gt;</p>");
  await command(["templates", "pull", "welcome", "--out", file]);
  const [updated] = await command(["templates", "push", file]); assert.equal(updated.version, 2);
});
test("webhook create/list/test and doctor expose scoped results without secrets", async () => {
  const [created] = await command(["webhooks", "create", "--url", "https://hooks.example.test/boxox", "--event", "message.delivered"]); hook = created;
  const [listed] = await command(["webhooks", "list"]); assert.ok(listed.data.some((h) => h.id === created.id));
  const [testEvent] = await command(["webhooks", "test", created.id]); assert.ok(testEvent.deliveryId);
  const [doctor] = await command(["doctor", "--webhook", created.id]);
  assert.equal(doctor.checks.read_log, "ok"); assert.equal(doctor.checks.webhookTest.status, "queued");
  assert.ok(!JSON.stringify(doctor).includes(domainKey)); assert.equal(doctor.setup, local.url + "/setup");
});
test("live hub forwards a signed event to localhost and isolates other domains", { timeout: 20000 }, async () => {
  const secret = "whsec_" + Buffer.alloc(24, 7).toString("base64"); const received = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    await verifyWebhook(body, req.headers, secret); received.push(JSON.parse(body)); res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const controller = new AbortController(); const output = [];
  let ready; const opened = new Promise((r) => { ready = r; });
  const listening = listen(new BoxOx({ key: domainKey, url: local.url }), `http://127.0.0.1:${server.address().port}/hook`, secret, true, (v) => { output.push(v); if (v.listening) ready(); }, controller.signal);
  try {
    await opened;
    await fetch(local.url + "/__emit/other-domain", { method: "POST" });
    await fetch(local.url + "/__emit/cli-domain", { method: "POST" });
    await listening;
    assert.equal(received.length, 1); assert.equal(received[0].type, "message.delivered"); assert.equal(output.at(-1).status, 204);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
test("a revoked active stream receives no later domain events", { timeout: 20000 }, async () => {
  const [created] = await command(["keys", "create", "--domain", "app.test", "--perm", "webhooks"], local.management.secret);
  const connect = (key) => new BoxOx({ key, url: local.url }).webhooks.listen((url, headers) => new WebSocket(url, { headers }));
  const ws = connect(created.secret), observer = connect(domainKey);
  try {
    await Promise.all([once(ws, "open"), once(observer, "open")]);
    const messages = []; ws.on("message", (frame) => messages.push(String(frame)));
    await command(["keys", "revoke", created.key.id], local.management.secret);
    const delivered = once(observer, "message");
    await fetch(local.url + "/__emit/cli-domain", { method: "POST" });
    await delivered; assert.equal(messages.length, 0);
    // Wrangler's HTTP WebSocket proxy may hold the close handshake open; delivery is the invariant.
  } finally { ws.terminate(); observer.terminate(); }
});
test("unknown options fail before taking action", async () => {
  await assert.rejects(command(["keys", "create", "--domain", "app.test", "--perms", "send"], local.management.secret), /Unknown option --perms/);
});
test("binary emits useful error and nonzero status without printing credentials", async () => {
  const result = await exec(process.execPath, [new URL("../dist/bin.js", import.meta.url).pathname, "messages", "get", "missing"], { env: { ...process.env, BOXOX_URL: local.url, BOXOX_KEY: domainKey } }).catch((e) => e);
  assert.equal(result.code, 1); assert.match(result.stderr, /boxox:/); assert.ok(!result.stderr.includes(domainKey));
});
