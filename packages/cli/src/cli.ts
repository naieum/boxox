import { BoxOx, BoxOxAgent, BoxOxError, type AgentWorkReference, signWebhook, type RequestBody, type Query } from "@boxox/mail";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { keychain, normalizeUrl, savedUrl, saveUrl, type Keychain } from "./credentials.js";
import { mcpRequest } from "./mcp.js";

export const VERSION = "0.3.0";

export const HELP = `boxox — developer email tools
  login --url URL --key KEY|-       Save credentials in the OS keychain
  keys create --domain DOMAIN --perm send [--perm read_log] [--name NAME]
  keys list | rotate ID [--overlap-hours N] | revoke ID
  send --from ADDRESS --to ADDRESS --subject TEXT [--text TEXT|--html HTML]
       [--file message.json] [--idempotency-key KEY]
  messages list [--status STATUS] [--recipient ADDRESS] [--tag TAG] [--cursor CURSOR] [--limit N]
  messages get ID | tail [--interval MS] [--once]
  templates push FILE | pull NAME [--out FILE] | preview NAME [--variables JSON]
  webhooks create --url HTTPS_URL [--event EVENT]
  webhooks list | test ID
  webhooks listen --forward-to http://localhost:PORT/path --secret WHSEC [--once]
  mcp request --url URL --mailbox EMAIL [--mailbox EMAIL] [--perm read|send|send_new|webhook|classify]
  mcp request --url URL --grant PERMISSION:EMAIL [--grant PERMISSION:EMAIL] [--server-name NAME]
  agent me
  agent changes ADDRESS_ID [--cursor CURSOR] [--limit N]
  agent threads ADDRESS_ID | thread THREAD_ID [--cursor CURSOR] [--limit N]
  agent message MESSAGE_ID [--include-body true|false]
  agent pending ADDRESS_ID [--group GROUP] [--cursor CURSOR] [--limit N]
  agent claim MESSAGE_ID [--group GROUP] [--lease-seconds N]
  agent complete MESSAGE_ID --claim-token TOKEN|- [--group GROUP]
  agent renew MESSAGE_ID --claim-token TOKEN|- [--group GROUP] [--lease-seconds N]
  agent retry MESSAGE_ID --claim-token TOKEN|- [--group GROUP] [--delay-seconds N]
  agent complete-batch --file FILE    A JSON object with up to 10 claim references in items
  agent send --file FILE [--idempotency-key KEY]
  doctor [--webhook ID]              Probe key capabilities; optionally queue a webhook test
Credentials: BOXOX_URL / BOXOX_KEY override saved login. All output is JSON.
Agent commands use BOXOX_AGENT_TOKEN (a short-lived bearer), never the saved developer key.
MCP request prepares OAuth scopes and login arguments; it does not grant access or store credentials.
--mailbox defaults to read; each --perm applies to every listed mailbox. Use --grant for different permissions per mailbox.
Thread/message bodies require --include-body true. Agent claim receipts contain claim tokens.
Creation and rotation print a one-time secret; capture it securely.
Doctor links to /setup for infrastructure and reports permission-limited checks explicitly.
`;

type Flags = Record<string, string[]>;
function parse(args: string[]) {
  const words: string[] = [], flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    const key = arg.slice(2);
    if (["help", "once"].includes(key)) { flags[key] = ["true"]; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    (flags[key] ??= []).push(value);
  }
  return { words, flags };
}
function value(flags: Flags, key: string, fallback?: string) { return flags[key]?.at(-1) ?? fallback; }
function required(flags: Flags, key: string) { const v = value(flags, key); if (!v) throw new Error(`--${key} is required`); return v; }
function numeric(flags: Flags, key: string, fallback?: number) { const v = value(flags, key); if (v === undefined) return fallback; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a nonnegative number`); return n; }
function id(words: string[], at = 2) { if (!words[at]) throw new Error("An ID or name is required"); return words[at]!; }
function json(text: string): Record<string, unknown> { const obj: unknown = JSON.parse(text); if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Expected a JSON object"); return obj as Record<string, unknown>; }
async function stdin(): Promise<string> { let data = ""; for await (const chunk of process.stdin) data += chunk; return data.trim(); }

export interface Runtime { keychain?: Keychain; output?: (value: unknown) => void; signal?: AbortSignal }
export async function run(args: string[], runtime: Runtime = {}): Promise<void> {
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) {
    (runtime.output ?? ((v: unknown) => process.stdout.write(String(v))))(VERSION + "\n");
    return;
  }
  const { words, flags } = parse(args);
  const output = runtime.output ?? ((v: unknown) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n"));
  const store = runtime.keychain ?? keychain;
  if (flags.help || !words.length) { output(HELP); return; }
  const permitted: Record<string, string[]> = {
    "mcp request": ["url", "mailbox", "perm", "grant", "server-name"],
    "agent me": [], "agent changes": ["cursor", "limit"], "agent threads": ["cursor", "limit"],
    "agent thread": ["cursor", "limit", "include-body"], "agent message": ["include-body"],
    "agent pending": ["group", "cursor", "limit"], "agent claim": ["group", "lease-seconds"],
    "agent complete": ["claim-token", "group"], "agent renew": ["claim-token", "group", "lease-seconds"],
    "agent retry": ["claim-token", "group", "delay-seconds"], "agent complete-batch": ["file"], "agent send": ["file", "idempotency-key"],
    login: ["url", "key"], "keys list": [], "keys create": ["domain", "name", "perm", "daily-send-cap"],
    "keys rotate": ["overlap-hours"], "keys revoke": [], send: ["file", "from", "to", "subject", "text", "html", "idempotency-key"],
    "messages list": ["status", "recipient", "tag", "cursor", "limit"], "messages get": [],
    "messages tail": ["status", "recipient", "tag", "cursor", "limit", "interval", "once"],
    "templates push": [], "templates pull": ["out"], "templates preview": ["variables"],
    "webhooks create": ["url", "event"], "webhooks list": [], "webhooks test": [],
    "webhooks listen": ["forward-to", "secret", "once"], doctor: ["webhook"],
  };
  const selected = ["login", "send", "doctor"].includes(words[0]!) ? words[0]! : words.slice(0, 2).join(" ");
  if (!permitted[selected]) throw new Error(`Unknown command: ${selected}. Run boxox --help.`);
  for (const flag of Object.keys(flags)) if (!permitted[selected]!.includes(flag)) throw new Error(`Unknown option --${flag} for ${selected}`);
  if (selected === "mcp request") {
    if (words.length !== 2) throw new Error("mcp request accepts mailbox choices as flags, not positional arguments");
    output(mcpRequest({ url: required(flags, "url"), mailboxes: flags.mailbox, permissions: flags.perm, grants: flags.grant, serverName: value(flags, "server-name") }));
    return;
  }
  const url = normalizeUrl(words[0] === "login" ? required(flags, "url") : process.env.BOXOX_URL ?? await savedUrl() ?? "");
  if (words[0] === "login") {
    const raw = required(flags, "key"), key = raw === "-" ? await stdin() : raw;
    if (!/^bx[mk]_[A-Za-z0-9_-]+$/.test(key)) throw new Error("Expected a bxm_ management key or bxk_ domain key");
    await store.set(url, key); await saveUrl(url); output({ saved: true, url }); return;
  }
  if (words[0] === "agent") {
    const mail = new BoxOxAgent({ url, token: process.env.BOXOX_AGENT_TOKEN });
    const page = { cursor: value(flags, "cursor"), limit: numeric(flags, "limit") };
    const bodyFlag = value(flags, "include-body");
    if (bodyFlag !== undefined && !["true", "false"].includes(bodyFlag)) throw new Error("--include-body must be true or false");
    const group = value(flags, "group");
    const claimReference = async () => {
      const claimToken = required(flags, "claim-token");
      return { messageId: id(words), claimToken: claimToken === "-" ? await stdin() : claimToken, group };
    };
    switch (words[1]) {
      case "me": output(await mail.me()); return;
      case "changes": output(await mail.changes(id(words), page)); return;
      case "threads": output(await mail.threads(id(words), page)); return;
      case "thread": output(await mail.thread(id(words), { ...page, includeBody: bodyFlag === "true" })); return;
      case "message": output(await mail.message(id(words), { includeBody: bodyFlag === "true" })); return;
      case "pending": output(await mail.work.pending(id(words), { ...page, group })); return;
      case "claim": output(await mail.work.claim({ messageId: id(words), group, leaseSeconds: numeric(flags, "lease-seconds") })); return;
      case "complete": output(await mail.work.complete(await claimReference())); return;
      case "renew": output(await mail.work.renew({ ...await claimReference(), leaseSeconds: numeric(flags, "lease-seconds") })); return;
      case "retry": output(await mail.work.retry({ ...await claimReference(), delaySeconds: numeric(flags, "delay-seconds") })); return;
      case "complete-batch": {
        const file = json(await readFile(required(flags, "file"), "utf8"));
        if (!Array.isArray(file.items) || !file.items.length || file.items.length > 10) throw new Error("items must contain 1–10 claim references");
        output(await mail.work.completeBatch(file.items as AgentWorkReference[])); return;
      }
      case "send": {
        const file = json(await readFile(required(flags, "file"), "utf8"));
        output(await mail.send(file as unknown as Parameters<BoxOxAgent["send"]>[0], { idempotencyKey: value(flags, "idempotency-key") })); return;
      }
    }
  }
  const key = process.env.BOXOX_KEY ?? await store.get(url);
  const mail = new BoxOx({ key, url });
  const command = words.slice(0, 2).join(" ");
  switch (command) {
    case "keys list": output(await mail.keys.list()); return;
    case "keys create": output(await mail.keys.create({ name: value(flags, "name", "project")!, domain: required(flags, "domain"), permissions: (flags.perm ?? ["send"]) as RequestBody<"createKey">["permissions"], dailySendCap: numeric(flags, "daily-send-cap") })); return;
    case "keys rotate": output(await mail.keys.rotate(id(words), { overlapHours: numeric(flags, "overlap-hours") })); return;
    case "keys revoke": output(await mail.keys.revoke(id(words))); return;
    case "messages get": output(await mail.messages.get(id(words))); return;
    case "messages list": output(await mail.messages.list(messageQuery(flags))); return;
    case "messages tail": {
      const seen = new Set<string>();
      do {
        // Walk every page so a burst larger than one page does not drop messages.
        for await (const message of mail.paginate(mail.messages.list, messageQuery(flags))) {
          if (!seen.has(message.id)) { output(message); seen.add(message.id); }
        }
        if (flags.once || runtime.signal?.aborted) return;
        await sleep(Math.max(100, numeric(flags, "interval", 2000)!), undefined, { signal: runtime.signal });
      } while (!runtime.signal?.aborted);
      return;
    }
    case "templates push": {
      const template = json(await readFile(id(words), "utf8")) as RequestBody<"createTemplate">;
      try { await mail.templates.get(template.name); }
      catch (error) { if (error instanceof BoxOxError && error.status === 404) { output(await mail.templates.create(template)); return; } throw error; }
      const { name, ...body } = template;
      output(await mail.templates.update(name, body)); return;
    }
    case "templates pull": {
      const template = await mail.templates.get(id(words));
      // Produce the same portable input accepted by templates push.
      const portable = { name: template.name, subject: template.subject, html: template.html, text: template.text, variables: template.variables };
      const path = value(flags, "out");
      if (path) { await writeFile(path, JSON.stringify(portable, null, 2) + "\n", { mode: 0o600 }); output({ written: path }); }
      else output(portable);
      return;
    }
    case "templates preview": output(await mail.templates.preview(id(words), { variables: json(value(flags, "variables", "{}")!) })); return;
    case "webhooks list": output(await mail.webhooks.list()); return;
    case "webhooks test": output(await mail.webhooks.test(id(words))); return;
    case "webhooks create": output(await mail.webhooks.create({ url: required(flags, "url"), events: (flags.event ?? []) as RequestBody<"createWebhook">["events"] })); return;
    case "webhooks listen": await listen(mail, required(flags, "forward-to"), required(flags, "secret"), !!flags.once, output, runtime.signal); return;
  }
  if (words[0] === "send") {
    const body = value(flags, "file") ? json(await readFile(required(flags, "file"), "utf8")) : {
      from: required(flags, "from"), to: flags.to ?? [], subject: required(flags, "subject"), text: value(flags, "text"), html: value(flags, "html"),
    };
    if (!value(flags, "file") && !flags.to?.length) throw new Error("--to is required");
    output(await mail.messages.send(body as RequestBody<"sendMessage">, { idempotencyKey: value(flags, "idempotency-key") })); return;
  }
  if (words[0] === "doctor") {
    const checks: Record<string, unknown> = {}, probes = key.startsWith("bxm_") ? { keys: () => mail.keys.list() } : {
      read_log: () => mail.messages.list({ limit: 1 }), templates: () => mail.templates.list({ limit: 1 }), webhooks: () => mail.webhooks.list(),
    };
    for (const [name, probe] of Object.entries(probes)) {
      try { await probe(); checks[name] = "ok"; }
      catch (error) { if (error instanceof BoxOxError && error.status === 403) checks[name] = { status: "permission_limited", code: error.code }; else throw error; }
    }
    if (value(flags, "webhook")) {
      const test = await mail.webhooks.test(required(flags, "webhook"));
      checks.webhookTest = { status: "queued", test, note: "Inspect webhook deliveries for the HTTP result; queuing does not prove reachability." };
    }
    output({ url, keyKind: key.startsWith("bxm_") ? "management" : "domain", checks, domainHealth: "Check the setup wizard; authenticated API reads do not verify DNS or Email Sending.", setup: `${url}/setup`, infrastructure: "wrangler deploy; wrangler secret put NAME" }); return;
  }
  throw new Error(`Unknown command: ${words.join(" ")}. Run boxox --help.`);
}
function messageQuery(flags: Flags): Query<"listMessages"> {
  return { status: value(flags, "status") as Query<"listMessages">["status"], tag: value(flags, "tag"), recipient: value(flags, "recipient"), cursor: value(flags, "cursor"), limit: numeric(flags, "limit") };
}

/** HTTP forwarding stays local; the SDK owns the authenticated remote connection. */
export async function listen(mail: BoxOx, target: string, secret: string, once: boolean, output: (v: unknown) => void, signal?: AbortSignal) {
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("--forward-to must be a localhost HTTP(S) URL");
  if (!/^whsec_/.test(secret)) throw new Error("--secret must be the local webhook signing secret (whsec_)");
  await new Promise<void>((resolve, reject) => {
    const ws = mail.webhooks.listen((url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10_000 }));
    let sequence = Promise.resolve(); let finishing = false;
    const stop = () => { finishing = true; ws.close(); resolve(); };
    signal?.addEventListener("abort", stop, { once: true });
    ws.on("open", () => output({ listening: true, forwardTo: url.href }));
    ws.on("error", reject);
    ws.on("close", () => { signal?.removeEventListener("abort", stop); if (!finishing) reject(new Error("Webhook listener disconnected; run the command again")); });
    ws.on("message", (data) => {
      sequence = sequence.then(async () => {
        if (finishing) return;
        const frame = json(String(data));
        if (typeof frame.id !== "string" || typeof frame.payload !== "string") throw new Error("Invalid webhook listener frame");
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = await signWebhook(secret, frame.id, timestamp, frame.payload);
        const status = await forward(url, frame.payload, { "content-type": "application/json", "webhook-id": frame.id, "webhook-timestamp": String(timestamp), "webhook-signature": signature });
        output({ id: frame.id, forwarded: status >= 200 && status < 300, status });
        if (status < 200 || status >= 300) throw new Error(`Local webhook returned HTTP ${status}`);
        if (once) stop();
      }).catch((error) => { finishing = true; ws.close(); reject(error); });
    });
  });
}
function forward(url: URL, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers, timeout: 10_000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("timeout", () => req.destroy(new Error("Local webhook timed out")));
    req.on("error", reject); req.end(body);
  });
}
