import { env, introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { blockedSenders, domains } from "@boxox/db";
import worker from "../src/index";
import { createDb } from "../src/db";
import { handleEmail, inboundRawKey, InboundRateLimited } from "../src/email";
import type { Env, IngestParams } from "../src/env";
import { getIngestJob, recoverStagedIngest } from "../src/services/ingest-dispatch";
import inbound from "./fixtures/cf/inbound-basic.json";
import { id, seedMailbox } from "./helpers/seed";

/**
 * email() against the recorded inbound message from the email spike
 * (fixtures/cf/inbound-basic.json): real D1, R2 and rate-limit bindings. Limit
 * tests control binding responses to avoid wall-clock window resets. The
 * workflow binding is the real one, or a recorder where a test needs to
 * observe or break create().
 */
const db = createDb(env);
const rawBytes = new TextEncoder().encode(inbound.raw);

interface FakeMessage extends ForwardableEmailMessage {
  rejected: string | null;
}

function message(over: { to?: string; from?: string; headerFrom?: string } = {}): FakeMessage {
  const headers = new Headers(inbound.headers as [string, string][]);
  if (over.headerFrom) headers.set("from", over.headerFrom);
  const msg = {
    from: over.from ?? inbound.from,
    to: over.to ?? inbound.to,
    headers,
    raw: new Response(rawBytes).body!,
    rawSize: rawBytes.byteLength,
    rejected: null as string | null,
    setReject(reason: string) {
      msg.rejected = reason;
    },
    forward: () => Promise.reject(new Error("forward not expected")),
    reply: () => Promise.reject(new Error("reply not expected")),
  };
  return msg as unknown as FakeMessage;
}

type Created = { id: string; params: IngestParams; storedAtCreate: Uint8Array | null };

function recordingWorkflow(onCreate?: () => void) {
  const created: Created[] = [];
  const binding = {
    async create(opts: { id: string; params: IngestParams }) {
      onCreate?.();
      const obj = await env.MAIL_STORE.get(opts.id);
      created.push({ ...opts, storedAtCreate: obj ? new Uint8Array(await obj.arrayBuffer()) : null });
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'complete' WHERE raw_key = ?").bind(opts.id).run();
      return { id: opts.id };
    },
  };
  return { created, binding: binding as unknown as Env["INGEST_WORKFLOW"] };
}

const withWorkflow = (wf: Env["INGEST_WORKFLOW"], over: Partial<Env> = {}): Env => ({ ...env, INGEST_QUEUE: undefined, INGEST_MAX_CONCURRENCY: "64", INGEST_WORKFLOW: wf, ...over });

async function listInbound(): Promise<string[]> {
  return (await env.MAIL_STORE.list({ prefix: "inbound-" })).objects.map((o) => o.key);
}

describe("email() handler", () => {
  it("stores the raw message in R2 before starting the workflow", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "store", domain, localPart: "ann" });
    const wf = recordingWorkflow();
    const msg = message({ to: `ann@${domain}`, headerFrom: "store-first@ext.test" });

    await handleEmail(msg, withWorkflow(wf.binding));

    expect(msg.rejected).toBeNull();
    expect(wf.created).toHaveLength(1);
    const [c] = wf.created;
    // The object was already in R2, byte for byte, when create() ran.
    expect(c!.storedAtCreate).toEqual(rawBytes);
    const head = await env.MAIL_STORE.head(c!.params.rawKey);
    expect(head?.httpMetadata?.contentType).toBe("message/rfc822");
    expect(head?.customMetadata).toEqual({ to: `ann@${domain}`, from: inbound.from, ingestVersion: "2", receivedAt: c!.params.receivedAt });
    expect(Number.isNaN(Date.parse(c!.params.receivedAt))).toBe(false);
  });

  it("rejects a blocked sender", async () => {
    const domain = `${id()}.test`;
    const box = await seedMailbox(db, { orgId: "blocked", domain, localPart: "ann" });
    await db.insert(blockedSenders).values({ id: id(), organizationId: box.orgId, email: "pest@ext.test", createdBy: "owner" });
    const wf = recordingWorkflow();
    const before = await listInbound();

    // Blocked by the From header, matched case-insensitively.
    const msg = message({ to: `ann@${domain}`, headerFrom: "Pest <PEST@ext.test>" });
    await handleEmail(msg, withWorkflow(wf.binding));
    expect(msg.rejected).toMatch(/^550 /);
    expect(wf.created).toHaveLength(0);
    expect(await listInbound()).toEqual(before);

    // A block in another organization does not apply here.
    const other = message({ to: `ann@${domain}`, headerFrom: "friend@ext.test" });
    await db.insert(blockedSenders).values({ id: id(), organizationId: "someone-else", email: "friend@ext.test", createdBy: "owner" });
    await handleEmail(other, withWorkflow(wf.binding));
    expect(other.rejected).toBeNull();
    expect(wf.created).toHaveLength(1);
  });

  it("rejects an unknown address when the domain policy is drop", async () => {
    const domain = `${id()}.test`;
    const box = await seedMailbox(db, { orgId: "drop", domain, localPart: "ann" });
    await db.update(domains).set({ unknownMailPolicy: "drop" }).where(eq(domains.id, box.domainId));
    const wf = recordingWorkflow();
    const before = await listInbound();

    const unknown = message({ to: `nobody@${domain}`, headerFrom: "drop-a@ext.test" });
    await handleEmail(unknown, withWorkflow(wf.binding));
    expect(unknown.rejected).toMatch(/^550 5\.1\.1/);
    expect(wf.created).toHaveLength(0);
    expect(await listInbound()).toEqual(before);

    // A known address (with a +tag) still delivers on a drop domain.
    const known = message({ to: `Ann+news@${domain}`, headerFrom: "drop-b@ext.test" });
    await handleEmail(known, withWorkflow(wf.binding));
    expect(known.rejected).toBeNull();
    expect(wf.created).toHaveLength(1);

    // The default hold policy never rejects an unknown address.
    const holdDomain = `${id()}.test`;
    await seedMailbox(db, { orgId: "drop", domain: holdDomain, localPart: "ann" });
    const held = message({ to: `nobody@${holdDomain}`, headerFrom: "drop-c@ext.test" });
    await handleEmail(held, withWorkflow(wf.binding));
    expect(held.rejected).toBeNull();
    expect(wf.created).toHaveLength(2);
  });

  it("retains accepted mail in the durable ledger when dispatch is unavailable", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "wf-fail", domain, localPart: "ann" });
    let attempts = 0;
    const broken = {
      create: async () => {
        attempts++;
        throw new Error("workflows unavailable");
      },
    } as unknown as Env["INGEST_WORKFLOW"];
    const msg = message({ to: `ann@${domain}`, headerFrom: "retry@ext.test" });

    await expect(handleEmail(msg, withWorkflow(broken))).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    const job = await env.DB.prepare("SELECT status FROM ingest_jobs ORDER BY created_at DESC LIMIT 1").first();
    expect(job).toMatchObject({ status: "running" });
    // No bounce after both the raw mail and recoverable job are durable.
    expect(msg.rejected).toBeNull();
  });

  it("retains and recovers the raw MIME if the job write fails after storage", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "job-write-fail", domain, localPart: "ann" });
    const before = new Set(await listInbound());
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("UPDATE ingest_jobs SET status = 'pending'")) throw new Error("D1 ledger unavailable");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(handleEmail(message({ to: `ann@${domain}`, headerFrom: "ledger@ext.test" }), withWorkflow(recordingWorkflow().binding, { DB }))).rejects.toThrow("D1 ledger unavailable");
    const added = (await listInbound()).filter(key => !before.has(key));
    expect(added).toHaveLength(1);
    const rawKey = added[0]!;
    expect(new Uint8Array(await (await env.MAIL_STORE.get(rawKey))!.arrayBuffer())).toEqual(rawBytes);
    expect(await getIngestJob(env, rawKey)).toMatchObject({ status: "staging" });
    await recoverStagedIngest(env, 50, Date.now() + 120_000);
    expect(await getIngestJob(env, rawKey)).toMatchObject({ status: "pending" });
  });

  it("rate-limits a flooding sender", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "flood", domain, localPart: "ann" });
    const wf = recordingWorkflow();
    const calls = new Map<string, number>();
    const e = withWorkflow(wf.binding, {
      // The local binding's wall-clock window can reset during these R2/D1
      // writes. Control its response to test how the handler enforces a denial.
      INBOUND_RATE_LIMIT: { limit: async ({ key }) => {
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        return { success: count <= 60 };
      } },
    });
    const before = (await listInbound()).length;

    let accepted = 0;
    let limited: unknown = null;
    for (let i = 0; i < 70 && !limited; i++) {
      try {
        await handleEmail(message({ to: `ann@${domain}`, headerFrom: "flood@ext.test" }), e);
        accepted++;
      } catch (err) {
        limited = err;
      }
    }
    expect(limited).toBeInstanceOf(InboundRateLimited);
    expect(accepted).toBe(60);
    expect(wf.created).toHaveLength(60);
    expect(calls.get("sender:flood@ext.test")).toBe(61);
    expect((await listInbound()).length - before).toBe(60);

    // Another sender is unaffected.
    const calm = message({ to: `ann@${domain}`, headerFrom: "calm@ext.test" });
    await handleEmail(calm, e);
    expect(calm.rejected).toBeNull();
    expect(wf.created).toHaveLength(61);
    expect(calls.get("sender:calm@ext.test")).toBe(1);
  });

  it("uses the R2 key as the workflow id", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "wf-id", domain, localPart: "ann" });
    const introspector = await introspectWorkflow(env.INGEST_WORKFLOW);
    try {
      const before = new Set(await listInbound());
      // Through the worker's exported email() and the real IngestWorkflow binding.
      const msg = message({ to: `ann@${domain}`, headerFrom: "wf-id@ext.test" });
      await worker.email(msg, { ...env, INGEST_QUEUE: undefined });
      expect(msg.rejected).toBeNull();

      const added = (await listInbound()).filter((k) => !before.has(k));
      expect(added).toHaveLength(1);
      const rawKey = added[0]!;
      const instance = await env.INGEST_WORKFLOW.get(rawKey);
      expect(instance.id).toBe(rawKey);
      expect(await introspector.get()).toHaveLength(1);

      expect(inboundRawKey(new Date("2026-10-17T12:00:00Z"), "u")).toBe("inbound-20261017-u");
      expect(rawKey).toMatch(/^inbound-\d{8}-[0-9a-f-]{36}$/);
    } finally {
      await introspector.dispose();
    }
  });
  it("bounds aggregate ingest when an attacker rotates sender headers", async () => {
    const domain = `${id()}.test`;
    await seedMailbox(db, { orgId: "rotating-flood", domain });
    const wf = recordingWorkflow();
    let globalCalls = 0;
    const e = withWorkflow(wf.binding, {
      INBOUND_GLOBAL_RATE_LIMIT: { limit: async ({ key }) => {
        expect(key).toBe("all-inbound");
        return { success: ++globalCalls <= 5 };
      } },
    });
    const before = (await listInbound()).length;
    let accepted = 0;
    let limited: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        await handleEmail(message({ to: `me@${domain}`, headerFrom: `rotating-${i}@ext.test` }), e);
        accepted++;
      } catch (err) { limited = err; break; }
    }
    expect(limited).toBeInstanceOf(InboundRateLimited);
    expect(accepted).toBe(5);
    expect(wf.created).toHaveLength(accepted);
    expect((await listInbound()).length - before).toBe(accepted);
    // Further unique senders are refused before either storage or workflow work.
    await expect(handleEmail(message({ to: `me@${domain}`, headerFrom: "last-unique@ext.test" }), e)).rejects.toBeInstanceOf(InboundRateLimited);
    expect(wf.created).toHaveLength(accepted);
  });

});
