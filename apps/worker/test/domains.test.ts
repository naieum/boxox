import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { AppContext } from "../src/middleware";
import { createDomainRoutes, DOH_URL, type DomainHealth } from "../src/routes/domains";
import { CF_API_BASE } from "../src/services/cloudflare";
import dnsStatus from "./fixtures/cf/sending-dns-status.json";
import sendingLimits from "./fixtures/cf/sending-limits.json";

const ORG = "owner";
const OWNER = "owner@example.test";
// Real ids from the email spike (docs/spikes/email.md).
const ACCOUNT = "00000000000000000000000000000001";
const OTHER_ACCOUNT = "0000000000000000000000000000beef";
const TOKEN = "fake-cf-token-for-tests";

let db: Db;

beforeAll(() => {
  db = createDb({ DB: env.DB });
});

type Responder = (url: URL) => { status?: number; body: unknown } | undefined;

/** Answers DoH and Cloudflare API calls; anything unanswered fails the test. */
function fakeNet(respond: Responder) {
  const urls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const hit = respond(url);
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, urls };
}

const cfOk = (result: unknown) => ({ body: { success: true, errors: [], messages: [], result } });

/** Public DNS as the spike recorded it for boxox.dev, renamed onto `domain`. */
function publicDns(domain: string, omit: string[] = []): Map<string, { type: number; data: string }[]> {
  const records = new Map<string, { type: number; data: string }[]>();
  for (const r of dnsStatus.response.result.records) {
    const name = r.name.replace("boxox.dev", domain);
    if (omit.includes(name)) continue;
    const rr = r.type === "MX" ? { type: 15, data: `${r.priority} ${r.content}` } : { type: 16, data: r.content };
    records.set(`${name}/${r.type}`, [...(records.get(`${name}/${r.type}`) ?? []), rr]);
  }
  return records;
}

function doh(records: Map<string, { type: number; data: string }[]>): Responder {
  return (url) => {
    if (`${url.origin}${url.pathname}` !== DOH_URL) return undefined;
    const answers = records.get(`${url.searchParams.get("name")}/${url.searchParams.get("type")}`);
    return { body: answers ? { Status: 0, Answer: answers } : { Status: 3 } };
  };
}

function appWith(fetcher: typeof fetch) {
  return new Hono<AppContext>()
    .use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: OWNER, email: OWNER, name: "Owner", role: "owner" });
      await next();
    })
    .route("/api/orgs/:orgId/domains", createDomainRoutes(fetcher));
}

async function seedDomain(name = `${crypto.randomUUID().slice(0, 8)}.test`) {
  const id = crypto.randomUUID();
  await db.insert(domains).values({ id, organizationId: ORG, name, sendingEnabled: true });
  return { id, name };
}

const noToken = {} as AppContext["Bindings"];
const withToken = { CF_API_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT } as AppContext["Bindings"];

describe("domains", () => {
  it("reports a missing DKIM record as unhealthy", async () => {
    const domain = await seedDomain();
    const dkimHost = `cf-bounce._domainkey.${domain.name}`;
    const post = (fetcher: typeof fetch) =>
      appWith(fetcher).request(`/api/orgs/${ORG}/domains/${domain.id}/health`, { method: "POST" }, noToken);

    const healthy = await post(fakeNet(doh(publicDns(domain.name))).fetcher);
    expect(healthy.status).toBe(200);
    const good = (await healthy.json()) as DomainHealth;
    expect(good.healthy).toBe(true);
    expect(good.checks.find((c) => c.name === "dkim")?.status).toBe("ok");

    const net = fakeNet(doh(publicDns(domain.name, [dkimHost])));
    const res = await post(net.fetcher);
    expect(res.status).toBe(200);
    const health = (await res.json()) as DomainHealth;
    expect(health.healthy).toBe(false);
    const dkim = health.checks.find((c) => c.name === "dkim")!;
    expect(dkim).toMatchObject({ host: dkimHost, status: "missing", required: true, found: [] });
    expect(dkim.detail).toMatch(/DKIM/);
    for (const name of ["spf", "dmarc"]) {
      expect(health.checks.find((c) => c.name === name)?.status).toBe("ok");
    }
    expect(net.urls.some((u) => u.searchParams.get("name") === dkimHost && u.searchParams.get("type") === "TXT")).toBe(true);

    const [stored] = await db.select().from(domains).where(eq(domains.id, domain.id));
    expect(stored!.health).toMatchObject({ healthy: false });
    expect(stored!.healthCheckedAt).toBeInstanceOf(Date);
  });

  it("lists only zones in this account", async () => {
    const onboarded = await seedDomain("boxox.dev");
    const zones = [
      { id: "fa4e000000000000000000000000002a", name: "boxox.dev", status: "active", account: { id: ACCOUNT } },
      { id: "a".repeat(32), name: "another.example", status: "pending", account: { id: ACCOUNT } },
      { id: "b".repeat(32), name: "not-mine.example", status: "active", account: { id: OTHER_ACCOUNT } },
    ];
    const net = fakeNet((url) =>
      url.href.startsWith(`${CF_API_BASE}/zones?`) ? cfOk(zones) : undefined,
    );
    const res = await appWith(net.fetcher).request(`/api/orgs/${ORG}/domains/zones`, {}, withToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; zones: { name: string; onboarded: boolean }[] };
    expect(body.configured).toBe(true);
    expect(body.zones).toEqual([
      { id: "a".repeat(32), name: "another.example", status: "pending", onboarded: false },
      { id: zones[0]!.id, name: onboarded.name, status: "active", onboarded: true },
    ]);
    expect(net.urls).toHaveLength(1);
    expect(net.urls[0]!.searchParams.get("account.id")).toBe(ACCOUNT);

    const unconfigured = await appWith(fakeNet(() => undefined).fetcher).request(
      `/api/orgs/${ORG}/domains/zones`,
      {},
      noToken,
    );
    expect(await unconfigured.json()).toEqual({ configured: false, zones: [] });
  });

  it("shows the sending quota", async () => {
    const limits = structuredClone(sendingLimits.response.result);
    limits.usage.sent = 250;
    const net = fakeNet((url) =>
      url.href === `${CF_API_BASE}/accounts/${ACCOUNT}/email/sending/limits` ? cfOk(limits) : undefined,
    );
    const res = await appWith(net.fetcher).request(`/api/orgs/${ORG}/domains/quota`, {}, withToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      limit: 1000,
      unit: "day",
      sent: 250,
      remaining: 750,
      overQuota: false,
      resetsAt: null,
    });

    const unconfigured = await appWith(fakeNet(() => undefined).fetcher).request(
      `/api/orgs/${ORG}/domains/quota`,
      {},
      noToken,
    );
    expect(await unconfigured.json()).toEqual({ configured: false });
  });
});
