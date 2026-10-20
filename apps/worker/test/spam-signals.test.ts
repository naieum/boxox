import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aiSettings, messages, spamFingerprints } from "@boxox/db";
import { OPENPHISH_FEED_URL, parseOpenPhishFeed, refreshOpenPhish } from "../src/crons/openphish";
import { createDb } from "../src/db";
import {
  findSpamFingerprint,
  forgetSpamFingerprint,
  hammingDistance,
  recordSpamFingerprint,
  simhash,
} from "../src/services/spam/fingerprint";
import {
  authSummary,
  decodePunycodeLabel,
  localSignals,
  lookalikeSignals,
  sendingIpOf,
  type Signal,
  type SignalMail,
} from "../src/services/spam/signals";
import {
  checkSecureResolver,
  checkSpamhaus,
  classifySpamhaus,
  loadOpenPhish,
  matchOpenPhish,
  OPENPHISH_KV_KEY,
  type Fetcher,
} from "../src/services/spam/signals-lookup";
import { collectSignals } from "../src/services/spam/signals-run";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

const OWNER = ["boxox.dev"];
const NOW = new Date("2026-10-17T12:00:00Z");
const CF_PASS = "mx.cloudflare.net; dkim=pass header.d=sender.example; spf=pass smtp.mailfrom=sender.example; dmarc=pass header.from=sender.example; arc=none";

function mail(overrides: Partial<SignalMail> = {}): SignalMail {
  return {
    headers: [
      { key: "received", value: "from mail.sender.example (203.0.113.7) by mx.cloudflare.net" },
      { key: "authentication-results", value: CF_PASS },
    ],
    fromEmail: "alice@sender.example",
    fromName: "Alice",
    replyTo: [],
    rfcMessageId: "<abc123@sender.example>",
    date: NOW.toUTCString(),
    text: "Hi, the meeting notes are attached. See you Tuesday.",
    html: null,
    attachments: [],
    ...overrides,
  };
}

const ids = (signals: Signal[]) => signals.map((s) => s.id);
const run = (m: SignalMail) => localSignals(m, { ownerDomains: OWNER, now: NOW });

/** A DoH fetcher that answers from a table, and records each query name. */
function dohFetcher(table: Record<string, { Status: number; answers: string[] }>, seen: string[] = []): Fetcher {
  return async (input) => {
    const name = new URL(input).searchParams.get("name")!;
    seen.push(name);
    const hit = table[name] ?? { Status: 3, answers: [] };
    return Response.json({ Status: hit.Status, Answer: hit.answers.map((data) => ({ name, type: 1, TTL: 60, data })) });
  };
}

describe("authentication results", () => {
  it("reads SPF, DKIM, DMARC and ARC from Cloudflare's header only", () => {
    const a = authSummary(mail().headers, "alice@sender.example");
    expect(a).toMatchObject({ trusted: true, spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" });

    const forged = authSummary(
      [{ key: "authentication-results", value: "mx.attacker.example; dmarc=pass header.from=sender.example" }],
      "alice@sender.example",
    );
    expect(forged).toMatchObject({ trusted: false, dmarc: "none" });
    expect(ids(run(mail({ headers: [{ key: "authentication-results", value: "mx.attacker.example; dmarc=pass" }] })).signals)).toContain("auth_untrusted");

    const failed = run(mail({ headers: [{ key: "authentication-results", value: "mx.cloudflare.net; spf=fail smtp.mailfrom=sender.example; dkim=fail header.d=sender.example; dmarc=fail header.from=sender.example" }] }));
    expect(ids(failed.signals)).toEqual(expect.arrayContaining(["dmarc_fail", "dkim_fail", "spf_fail"]));
  });

  it("finds the sending IP in Cloudflare's Received header", () => {
    expect(sendingIpOf(mail().headers)).toBe("203.0.113.7");
    expect(sendingIpOf([{ key: "received", value: "from x.example ([198.51.100.4]) by mx.cloudflare.net" }])).toBe("198.51.100.4");
  });
});

describe("header and structure rules", () => {
  it("raises nothing suspicious on ordinary authenticated mail", () => {
    const r = run(mail());
    expect(r.signals.filter((s) => s.weight > 0)).toEqual([]);
    expect(r.score).toBeLessThan(0);
  });

  it("flags a display name that spoofs the owner's domain", () => {
    const withAddress = run(mail({ fromName: "security@boxox.dev", fromEmail: "notify@evil-mailer.example" }));
    const s = withAddress.signals.find((x) => x.id === "display_name_spoofs_owner");
    expect(s).toBeDefined();
    expect(s!.weight).toBeGreaterThanOrEqual(4);
    expect(s!.detail).toBe("boxox.dev via evil-mailer.example");

    const withDomain = run(mail({ fromName: "Boxox.dev Account Team", fromEmail: "team@evil-mailer.example" }));
    expect(ids(withDomain.signals)).toContain("display_name_spoofs_owner");

    // The owner's own mail, authenticated, with the domain in its name, is fine.
    const own = run(mail({
      fromName: "boxox.dev support",
      fromEmail: "support@boxox.dev",
      headers: [{ key: "authentication-results", value: "mx.cloudflare.net; dkim=pass header.d=boxox.dev; dmarc=pass header.from=boxox.dev" }],
      rfcMessageId: "<1@boxox.dev>",
    }));
    expect(ids(own.signals)).not.toContain("display_name_spoofs_owner");
    expect(ids(own.signals)).not.toContain("owner_domain_spoof");

    // The owner's domain in From: without authentication is a spoof by itself.
    const forged = run(mail({ fromEmail: "ceo@boxox.dev", headers: [{ key: "authentication-results", value: "mx.cloudflare.net; dmarc=fail header.from=boxox.dev" }] }));
    expect(ids(forged.signals)).toContain("owner_domain_spoof");
  });

  it("flags a look-alike punycode domain", () => {
    // "pаypal.com" with a Cyrillic а, and "bоxox.dev" with a Cyrillic о.
    expect(decodePunycodeLabel("xn--pypal-4ve")).toBe("pаypal");
    expect(decodePunycodeLabel("xn--bxox-55d")).toBe("bоxox");
    expect(ids(lookalikeSignals("xn--pypal-4ve.com", OWNER))).toEqual(["punycode_domain", "lookalike_brand_domain"]);
    expect(ids(lookalikeSignals("xn--bxox-55d.dev", OWNER))).toEqual(["punycode_domain", "lookalike_owner_domain"]);
    expect(lookalikeSignals("paypal.com", OWNER)).toEqual([]);
    expect(lookalikeSignals("boxox.dev", OWNER)).toEqual([]);

    const fromLookalike = run(mail({ fromEmail: "billing@xn--bxox-55d.dev" }));
    expect(ids(fromLookalike.signals)).toEqual(expect.arrayContaining(["from_punycode_domain", "from_lookalike_owner_domain"]));

    const linked = run(mail({ html: '<p>Verify <a href="https://pаypal.com/login">your account</a></p>', text: "Verify your account" }));
    const hit = linked.signals.find((s) => s.id === "lookalike_brand_domain");
    expect(hit?.detail).toBe("xn--pypal-4ve.com ~ paypal");
  });

  it("flags link text that shows a different domain", () => {
    const html = `<p>Sign in at <a href="https://login.evil-host.example/x?id=1"><b>https://www.paypal.com</b>/signin</a>
      or our <a href="https://help.sender.example/faq">help.sender.example</a>
      or <a href="https://tracking.sender.example/c/1">Click here</a></p>`;
    const r = run(mail({ html, text: "Sign in" }));
    const mismatches = r.signals.filter((s) => s.id === "link_text_mismatch");
    expect(mismatches).toEqual([{ id: "link_text_mismatch", weight: 3, detail: "paypal.com -> login.evil-host.example" }]);
    expect(r.links.map((l) => l.host)).toEqual(["login.evil-host.example", "help.sender.example", "tracking.sender.example"]);

    const entity = run(mail({ html: '<a href="http://203.0.113.9/a">bank&#46;example</a> <a href="https://bit.ly/x">x</a>', text: "x" }));
    expect(ids(entity.signals)).toEqual(expect.arrayContaining(["link_text_mismatch", "ip_link", "url_shortener"]));
  });

  it("flags Reply-To mismatch, bad attachments, odd dates and Message-ID", () => {
    const encryptedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x01, 0x00, 0, 0]);
    const r = run(mail({
      replyTo: ["collect@other.example"],
      date: new Date(NOW.getTime() + 3 * 24 * 3600_000).toUTCString(),
      rfcMessageId: "<x@bulk.mailer.example>",
      html: '<img src="cid:a"><img src="cid:b">',
      text: "",
      attachments: [
        { filename: "invoice.pdf.exe", contentType: "application/octet-stream" },
        { filename: "statement.html", contentType: "text/html" },
        { filename: "docs.zip", contentType: "application/zip", content: encryptedZip },
        { filename: "report.pdf", contentType: "application/pdf" },
      ],
    }));
    expect(ids(r.signals)).toEqual(expect.arrayContaining([
      "reply_to_mismatch", "double_extension", "dangerous_attachment", "encrypted_archive",
      "date_future", "message_id_domain_mismatch", "html_only", "mostly_images",
    ]));
    expect(r.signals.filter((s) => s.id === "dangerous_attachment").map((s) => s.detail)).toEqual(["html"]);
    expect(ids(run(mail({ date: "Mon, 1 Jan 2024 00:00:00 +0000", rfcMessageId: null })).signals)).toEqual(expect.arrayContaining(["date_past", "message_id_missing"]));
  });
});

describe("reputation lookups", () => {
  it("treats 0.0.0.0 from 1.1.1.2 as blocked and failures as errors", async () => {
    const seen: string[] = [];
    const fetcher = dohFetcher({ "malware.testcategory.com": { Status: 0, answers: ["0.0.0.0"] }, "example.com": { Status: 0, answers: ["93.184.215.14"] } }, seen);
    const r = await checkSecureResolver(["malware.testcategory.com", "example.com"], fetcher);
    expect(r.signals).toEqual([{ id: "cf_security_blocked", weight: 6, detail: "malware.testcategory.com" }]);
    expect(seen.sort()).toEqual(["example.com", "malware.testcategory.com"]);

    const down = await checkSecureResolver(["example.com"], async () => new Response("no", { status: 502 }));
    expect(down).toEqual({ signals: [], errors: ["1.1.1.2:example.com"] });
  });

  it("treats 127.255.255.x Spamhaus answers as errors, not listings", async () => {
    for (const code of ["127.255.255.252", "127.255.255.254", "127.255.255.255"]) {
      const c = classifySpamhaus("203.0.113.7", [code]);
      expect(c.listed).toEqual([]);
      expect(c.error).toBeTruthy();
    }
    expect(classifySpamhaus("203.0.113.7", ["127.0.0.4"])).toEqual({ name: "203.0.113.7", listed: ["127.0.0.4"], error: null });

    const key = "fakedqskey0123456789";
    const seen: string[] = [];
    const errored = await checkSpamhaus(
      { key, ip: "203.0.113.7", domains: ["phish.example"] },
      dohFetcher({
        [`7.113.0.203.${key}.zen.dq.spamhaus.net`]: { Status: 0, answers: ["127.255.255.254"] },
        [`phish.example.${key}.dbl.dq.spamhaus.net`]: { Status: 0, answers: ["127.255.255.255"] },
      }, seen),
    );
    expect(errored.signals).toEqual([]);
    expect(errored.errors.sort()).toEqual(["spamhaus:dbl:excessive number of queries", "spamhaus:zen:query via public resolver refused"]);
    expect(seen).toContain(`7.113.0.203.${key}.zen.dq.spamhaus.net`);

    const listed = await checkSpamhaus(
      { key, ip: "203.0.113.7", domains: ["phish.example", "clean.example"] },
      dohFetcher({
        [`7.113.0.203.${key}.zen.dq.spamhaus.net`]: { Status: 0, answers: ["127.0.0.2"] },
        [`phish.example.${key}.dbl.dq.spamhaus.net`]: { Status: 0, answers: ["127.0.1.4"] },
      }),
    );
    expect(ids(listed.signals).sort()).toEqual(["spamhaus_dbl", "spamhaus_zen"]);
    expect(listed.errors).toEqual([]);
  });

  it("refreshes the OpenPhish feed into KV and matches links against it", async () => {
    const db = createDb(env);
    await db.delete(aiSettings);
    await env.KV.delete(OPENPHISH_KV_KEY);
    const feed = "https://phish.example/login/\nhttp://sites.example.com/bad/page?x=1\nnot a url\n";
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls++;
      expect(url).toBe(OPENPHISH_FEED_URL);
      return new Response(feed);
    };
    expect(await refreshOpenPhish(env, fetcher)).toBe("skipped");
    expect(calls).toBe(0);

    await db.insert(aiSettings).values({ id: 1, localFilters: true, reputationLookups: true, ai: false });
    expect(await refreshOpenPhish(env, fetcher)).toBe("updated");
    expect(parseOpenPhishFeed(feed)).toEqual(["phish.example/login", "sites.example.com/bad/page"]);
    const entries = await loadOpenPhish(env.KV);
    expect([...entries]).toEqual(["phish.example/login", "sites.example.com/bad/page"]);

    expect(await refreshOpenPhish(env, async () => new Response("", { status: 500 }))).toBe("failed");
    expect((await loadOpenPhish(env.KV)).size).toBe(2);

    const hits = matchOpenPhish(["https://phish.example/login/step2", "https://sites.example.com/good", "https://phish.example/"], entries);
    expect(hits).toEqual([{ id: "openphish_listed", weight: 8, detail: "phish.example" }]);
  });
});

describe("campaign fingerprints", () => {
  const SPAM = `Dear John Smith, congratulations! You have been selected to receive a $500 gift card from our
    loyalty rewards program. To claim your reward, confirm your shipping details within 48 hours at
    https://claim.rewards-a.example/u/8812. This exclusive offer expires on 10/20/2026. Reference number 77120.
    If you do not respond your reward will be transferred to another customer. Thank you for being a valued member.`;
  const VARIANT = `Dear Maria Garcia, congratulations! You have been selected to receive a $750 gift card from our
    loyalty rewards program. To claim your reward, confirm your shipping details within 24 hours at
    https://win.prize-b.example/r/1199. This exclusive offer expires on 11/02/2026. Reference number 30018.
    If you do not respond your reward will be transferred to another customer. Thank you for being a loyal member.`;
  const HAM = `Hi team, attached are the minutes from Tuesday's planning meeting. We agreed to move the launch
    review to next week so design has time to finish the onboarding screens. Please add comments to the doc
    before Friday, and let me know if the new agenda works for the client call. Thanks, Priya`;

  beforeEach(async () => {
    await createDb(env).delete(spamFingerprints);
  });

  it("matches a near-duplicate of known spam by fingerprint", async () => {
    const db = createDb(env);
    const a = simhash(SPAM)!;
    const b = simhash(VARIANT)!;
    const c = simhash(HAM)!;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(10);
    expect(hammingDistance(a, c)).toBeGreaterThan(16);
    expect(simhash("too short to say anything")).toBeNull();

    expect(await findSpamFingerprint(db, b)).toBeNull();
    expect(await recordSpamFingerprint(db, null, { text: SPAM, html: null })).toBe(a);
    const match = await findSpamFingerprint(db, b);
    expect(match).not.toBeNull();
    expect(match!.hash).toBe(a);
    expect(match!.distance).toBe(hammingDistance(a, b));
    expect(await findSpamFingerprint(db, c)).toBeNull();

    await db.insert(aiSettings).values({ id: 1, localFilters: true, reputationLookups: false, ai: false }).onConflictDoUpdate({
      target: aiSettings.id,
      set: { localFilters: true, reputationLookups: false },
    });
    const noNetwork: Fetcher = async () => {
      throw new Error("lookups are off; nothing may be fetched");
    };
    const layer1 = await collectSignals(env, db, mail({ text: VARIANT }), { ownerDomains: OWNER, now: NOW }, noNetwork);
    expect(layer1.ran).toBe(true);
    expect(layer1.lookups).toBe(false);
    expect(ids(layer1.signals)).toContain("spam_fingerprint");
    const hamResult = await collectSignals(env, db, mail({ text: HAM }), { ownerDomains: OWNER, now: NOW }, noNetwork);
    expect(ids(hamResult.signals)).not.toContain("spam_fingerprint");
  });

  it("records once per message and forgets when the owner un-marks the spam", async () => {
    const db = createDb(env);
    const box = await seedMailbox(db, { orgId: "org-fp" });
    const threadId = await seedThread(db, box);
    const row = messageRow(box, threadId);
    await db.insert(messages).values(row);

    await recordSpamFingerprint(db, row.id, { text: null, html: `<p>${SPAM}</p>` });
    await recordSpamFingerprint(db, row.id, { text: null, html: `<p>${SPAM}</p>` });
    expect(await db.select().from(spamFingerprints)).toHaveLength(1);
    expect((await findSpamFingerprint(db, simhash(VARIANT)!))?.messageId).toBe(row.id);

    await forgetSpamFingerprint(db, row.id);
    expect(await findSpamFingerprint(db, simhash(VARIANT)!)).toBeNull();
  });

  it("runs nothing until the owner turns local filters on", async () => {
    const db = createDb(env);
    await db.delete(aiSettings);
    const r = await collectSignals(env, db, mail({ fromEmail: "ceo@boxox.dev" }), { ownerDomains: OWNER, now: NOW });
    expect(r).toMatchObject({ ran: false, signals: [], score: 0 });
  });
});
