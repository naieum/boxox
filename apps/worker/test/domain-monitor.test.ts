import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiSettings, domains } from "@boxox/db";
import { createDb } from "../src/db";
import { checkDomainHealth, judgeBimi, judgeDmarc, type HealthCheck } from "../src/services/domain-health";
import { monitorDomain } from "../src/services/domain-monitor";
import { monitorDomains } from "../src/crons/domain-monitor";

const db = createDb(env);
const key = "synthetic123456";
const good = { receivingEnabled: false, sendingEnabled: true, organizationId: "default", name: "sender.test" };
function network(opts: { dkimMissing?: boolean; listed?: boolean; dnsError?: boolean } = {}, seen: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const name = url.searchParams.get("name")!; seen.push(name);
    let data: string | null = null; let type = 16;
    if (name.endsWith(".dq.spamhaus.net")) {
      if (opts.dnsError) return Response.json({ Status: 2 });
      data = opts.listed ? "127.0.1.2" : null; type = 1;
    } else if (name.startsWith("cf-bounce._domainkey.")) data = opts.dkimMissing ? null : "v=DKIM1; p=abcDEF123";
    else if (name.startsWith("cf-bounce.")) data = "v=spf1 include:_spf.mx.cloudflare.net ~all";
    else if (name.startsWith("_dmarc.")) data = "v=DMARC1; p=reject";
    else if (name.startsWith("default._bimi.")) data = "v=BIMI1; l=https://brand.test/logo.svg";
    return Response.json({ Status: data ? 0 : 3, Answer: data ? [{ type, data }] : [] });
  }) as typeof fetch;
}
const policy = (value: string): HealthCheck => ({ name: "dmarc", host: "_dmarc.sender.test", type: "TXT", required: true, status: "ok", found: [value] });

beforeEach(async () => { await db.delete(domains); await db.delete(aiSettings); });

describe("DMARC and BIMI guidance", () => {
  it("rejects duplicate policies, missing policy, and partial BIMI enforcement", () => {
    expect(judgeDmarc(["v=DMARC1; p=reject", "v=DMARC1; p=none"]).status).toBe("invalid");
    expect(judgeDmarc(["v=DMARC1; p=reject; p=none"]).status).toBe("invalid");
    expect(judgeDmarc(["v=DMARC1"]).status).toBe("invalid");
    expect(judgeDmarc(["v=DMARC1; p=none"]).status).toBe("ok");
    const record = ["v=BIMI1; l=https://brand.test/logo.svg; a=https://brand.test/cert.pem"];
    for (const value of ["v=DMARC1; p=none", "v=DMARC1; p=reject; pct=50", "v=DMARC1; p=reject; sp=none"])
      expect(judgeBimi(record, policy(value)).status).toBe("invalid");
    expect(judgeBimi(record, policy("v=DMARC1; p=reject")).detail).toMatch(/still need verification/);
    expect(judgeBimi(["v=BIMI1; l=http://brand.test/logo.svg"], policy("v=DMARC1; p=reject")).status).toBe("invalid");
  });
  it("keeps optional BIMI failures separate from mail health and never downloads the logo", async () => {
    const seen: string[] = [];
    const health = await checkDomainHealth(good.name, { bimi: true }, network({}, seen));
    expect(health.healthy).toBe(true);
    expect(health.checks.find(c => c.name === "bimi")?.status).toBe("ok");
    expect(seen).toHaveLength(5);
    expect(seen.some(n => n.includes("brand.test"))).toBe(false);
  });
});

it("records DNS regressions and recoveries once, preserving the five latest alerts", async () => {
  await db.insert(domains).values({ ...good, id: "monitor" });
  const load = async () => (await db.select().from(domains).where(eq(domains.id, "monitor")))[0]!;
  const healthy = await monitorDomain(db, {}, await load(), network());
  expect(healthy.alerts).toEqual([]);
  const broken = await monitorDomain(db, {}, await load(), network({ dkimMissing: true }));
  expect(broken.alerts?.[0]).toMatchObject({ kind: "problem", checks: ["dkim"] });
  const repeated = await monitorDomain(db, {}, await load(), network({ dkimMissing: true }));
  expect(repeated.alerts).toHaveLength(1);
  const repaired = await monitorDomain(db, {}, await load(), network());
  expect(repaired.alerts?.[0]).toMatchObject({ kind: "recovered", checks: ["dkim"] });
});

it("requires consent and a key; DNS errors never clear an existing listing or expose the key", async () => {
  await db.insert(domains).values({ ...good, id: "rep" });
  const load = async () => (await db.select().from(domains).where(eq(domains.id, "rep")))[0]!;
  const seen: string[] = [];
  expect((await monitorDomain(db, { SPAMHAUS_DQS_KEY: key }, await load(), network({}, seen))).reputation?.status).toBe("off");
  expect(seen.some(n => n.includes(key))).toBe(false);
  await db.insert(aiSettings).values({ id: 1, reputationLookups: true });
  const listed = await monitorDomain(db, { SPAMHAUS_DQS_KEY: key }, await load(), network({ listed: true }));
  expect(listed.reputation?.status).toBe("listed");
  expect(JSON.stringify(listed)).not.toContain(key);
  const unknown = await monitorDomain(db, { SPAMHAUS_DQS_KEY: key }, await load(), network({ dnsError: true }));
  expect(unknown.reputation).toMatchObject({ status: "unknown", lastKnown: "listed" });
  expect(unknown.alerts?.[0]?.kind).toBe("problem");
  const clear = await monitorDomain(db, { SPAMHAUS_DQS_KEY: key }, await load(), network());
  expect(clear.reputation?.status).toBe("clear");
  expect(clear.alerts?.[0]?.kind).toBe("recovered");
});

it("bounds scheduled work to five domains and rotates to the oldest unchecked domains", async () => {
  for (let i=0;i<7;i++) await db.insert(domains).values({ ...good, id: `d${i}`, name: `d${i}.test` });
  await db.insert(domains).values({ ...good, id: "inactive", name: "inactive.test", active: false });
  await monitorDomains(env, network());
  let rows = await db.select().from(domains);
  expect(rows.filter(d => d.healthCheckedAt)).toHaveLength(5);
  await monitorDomains(env, network());
  rows = await db.select().from(domains);
  expect(rows.filter(d => d.healthCheckedAt)).toHaveLength(7);
  expect(rows.find(d => d.id === "inactive")?.healthCheckedAt).toBeNull();
});
