import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { run } from "../dist/cli.js";

let server, url;
const requests = [];
const original = { ...process.env };
before(async () => {
  server = createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: data ? JSON.parse(data) : undefined });
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/complete")) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "claim_lost", message: "Claim expired" } })); }
    else res.end(JSON.stringify({ messages: [], changes: [], nextCursor: "checkpoint", hasMore: false }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening"); url = `http://127.0.0.1:${server.address().port}`;
  process.env.BOXOX_URL = url; process.env.BOXOX_AGENT_TOKEN = "synthetic-agent-bearer"; process.env.BOXOX_KEY = "bxk_wrong_api";
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const name of ["BOXOX_URL", "BOXOX_AGENT_TOKEN", "BOXOX_KEY"]) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
});
async function command(args) {
  const output = [];
  await run(["agent", ...args], { output: value => output.push(value), keychain: { get: async () => { throw new Error("Agent commands must not read the developer keychain"); }, set: async () => {} } });
  return output;
}
test("agent CLI uses only agent bearer and preserves checkpoint/body/work flags", async () => {
  await command(["changes", "a1", "--cursor", "opaque+/=", "--limit", "50"]);
  await command(["message", "m1"]);
  await command(["message", "m1", "--include-body", "true"]);
  await command(["pending", "a1", "--group", "support"]);
  await command(["claim", "m1", "--group", "support", "--lease-seconds", "300"]);
  assert.deepEqual(requests.map(r => r.path), ["/api/agent/v1/addresses/a1/changes?cursor=opaque%2B%2F%3D&limit=50", "/api/agent/v1/messages/m1?includeBody=false", "/api/agent/v1/messages/m1?includeBody=true", "/api/agent/v1/addresses/a1/work?group=support", "/api/agent/v1/work/claim"]);
  assert.ok(requests.every(r => r.authorization === "Bearer synthetic-agent-bearer"));
  assert.deepEqual(requests.at(-1).body, { messageId: "m1", group: "support", leaseSeconds: 300 });
});
test("agent CLI surfaces lost claims without echoing credentials or auto-retrying", async () => {
  const before = requests.length;
  await assert.rejects(command(["complete", "m1", "--claim-token", "synthetic-claim-token"]), error => {
    assert.equal(error.code, "claim_lost"); assert.equal(error.status, 409);
    assert.ok(!error.message.includes("synthetic")); return true;
  });
  assert.equal(requests.length, before + 1);
});
test("agent CLI rejects missing agent auth instead of falling back to developer keys", async () => {
  delete process.env.BOXOX_AGENT_TOKEN;
  try { await assert.rejects(command(["me"]), /BOXOX_AGENT_TOKEN/); }
  finally { process.env.BOXOX_AGENT_TOKEN = "synthetic-agent-bearer"; }
  await assert.rejects(command(["message", "m1", "--include-body", "yes"]), /true or false/);
  await assert.rejects(command(["claim", "m1", "--unknown", "anything"]), /Unknown option/);
});
