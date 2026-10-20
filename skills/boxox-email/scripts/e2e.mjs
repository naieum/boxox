import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startLocal } from "../../../packages/cli/test/local.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "packages/cli/dist/boxox.mjs");
const sample = await mkdtemp(join(tmpdir(), "boxox-skill-e2e-"));
let local, server, listener;
const keyIds = [];
async function command(args, key) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { env: { ...process.env, BOXOX_URL: local.url, BOXOX_KEY: key, BOXOX_CONFIG_DIR: sample }, timeout: 15000 });
    return JSON.parse(result.stdout);
  } catch (error) {
    // Never print the child process command/environment or its captured secrets.
    throw new Error(`CLI ${args.slice(0, 2).join(" ")} failed: ${String(error.stderr ?? "").replace(/bx[mk]_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+/g, "[redacted]")}`);
  }
}
try {
  local = await startLocal();
  await symlink(join(root, "packages/cli/node_modules"), join(sample, "node_modules"), "dir");
  for (const file of ["send-email.mjs", "webhook-route.mjs"]) await copyFile(new URL(`../assets/${file}`, import.meta.url), join(sample, file));
  const { sendEmail } = await import(pathToFileURL(join(sample, "send-email.mjs")));
  const { handleWebhook } = await import(pathToFileURL(join(sample, "webhook-route.mjs")));
  const appKey = await command(["keys", "create", "--domain", "app.test", "--name", "sample-app", "--perm", "send"], local.management.secret);
  keyIds.push(appKey.key.id); assert.deepEqual(appKey.key.permissions, ["send"]);
  const operator = await command(["keys", "create", "--domain", "app.test", "--name", "local-operator", "--perm", "read_log", "--perm", "webhooks", "--perm", "templates"], local.management.secret);
  keyIds.push(operator.key.id);
  await command(["templates", "push", join(root,"skills/boxox-email/assets/invoice-template.json")], operator.secret);
  const invoice = await command(["templates", "preview", "invoice-due", "--variables", JSON.stringify({invoice_id:"1042", amount:"USD 240.00", due_date:"October 21, 2026", invoice_url:"https://app.example.test/invoices/1042"})], operator.secret);
  for (const part of [invoice.html, invoice.text]) {
    for (const fact of ["1042", "USD 240.00", "October 21, 2026", "https://app.example.test/invoices/1042"]) assert.ok(part.includes(fact), "Invoice rendering preserves facts and action URL in both parts");
  }
  const env = { BOXOX_URL: local.url, BOXOX_KEY: appKey.secret };
  const sent = await sendEmail(env, { from: "hello@app.test", to: "recipient@example.test", subject: "Sample project", text: "Local SDK test" }, "skill-sdk-send");
  assert.equal(sent.status, "queued");
  const cliSent = await command(["send", "--from", "hello@app.test", "--to", "recipient@example.test", "--subject", "Integration check", "--text", "Box Ox integration check", "--idempotency-key", "integration-check-1"], appKey.secret);
  assert.equal(cliSent.status, "queued");
  const list = await command(["messages", "list", "--limit", "10"], operator.secret);
  assert.ok(list.data.some((m) => m.id === sent.id));
  const detail = await command(["messages", "get", sent.id], operator.secret); assert.equal(detail.subject, "Sample project");
  const diagnostic = await command(["doctor"], appKey.secret);
  assert.equal(diagnostic.checks.read_log.status, "permission_limited");
  const hook = await command(["webhooks", "create", "--url", "https://sample.example.test/webhooks/boxox", "--event", "message.delivered", "--event", "message.bounced"], operator.secret);
  env.BOXOX_WEBHOOK_SECRET = hook.secret;
  const received = [];
  server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://localhost${req.url}`, { method: "POST", headers: req.headers, body: Buffer.concat(chunks) });
      const response = await handleWebhook(request, env, async (event, id) => { assert.ok(id); received.push(event); });
      res.writeHead(response.status).end(await response.text());
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const target = `http://127.0.0.1:${server.address().port}/webhooks/boxox`;
  const bad = await fetch(target, { method: "POST", body: '{"type":"message.delivered"}', headers: { "webhook-id": "bad", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,aW52YWxpZA==" } });
  assert.equal(bad.status, 400); assert.equal(received.length, 0);
  listener = spawn(process.execPath, [cli, "webhooks", "listen", "--forward-to", target, "--secret", hook.secret, "--once"], { env: { ...process.env, BOXOX_URL: local.url, BOXOX_KEY: operator.secret }, stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Local listener exited unsuccessfully")));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Listener did not become ready")), 10000);
    let output = "";
    listener.stdout.on("data", (chunk) => { output += chunk; if (output.includes('"listening": true')) { clearTimeout(timer); resolve(); } });
    listener.once("exit", () => { clearTimeout(timer); reject(new Error("Listener stopped before ready")); });
  });
  await command(["webhooks", "test", hook.id], operator.secret);
  await Promise.race([completion, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("No verified local event arrived")), 10000); timer.unref(); })]);
  assert.equal(received.length, 1); assert.equal(received[0].type, "webhook.test");
  const doctor = await command(["doctor", "--webhook", hook.id], operator.secret); assert.equal(doctor.checks.webhookTest.status, "queued");
  console.log("boxox-email e2e: Wrangler auth, least-permission keys, SDK sample, CLI send/log/doctor, HTML/text invoice preview, invalid-signature rejection and verified local webhook passed");
} finally {
  if (listener && listener.exitCode === null) listener.kill("SIGTERM");
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (local) {
    for (const id of keyIds) await command(["keys", "revoke", id], local.management.secret).catch(() => {});
    await local.worker.stop();
  }
  await rm(sample, { recursive: true, force: true });
}
