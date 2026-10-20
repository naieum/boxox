import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages, spamTokens, spamTraining } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import { learn, MESSAGE_COUNT_TOKEN, score, tokenize, unlearn, type BayesMail } from "../src/services/spam/bayes";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

const HAM: BayesMail[] = [
  { subject: "Planning meeting notes", fromEmail: "priya@client.example", html: null, text: "Hi team, attached are the minutes from Tuesday's planning meeting. Please add comments to the agenda before Friday." },
  { subject: "Invoice for October", fromEmail: "billing@vendor.example", html: null, text: "Your October invoice is attached. Payment is due within thirty days of the invoice date. Thanks for your business." },
  { subject: "Dinner on Saturday?", fromEmail: "sam@friends.example", html: null, text: "Are you free for dinner on Saturday? We could try the new place near the station, maybe around seven." },
];
const SPAM: BayesMail = {
  subject: "Exclusive crypto opportunity",
  fromEmail: "promo@coinz.example",
  html: null,
  text: "Guaranteed bitcoin profits! Double your crypto investment overnight with our exclusive trading signals. Click https://coinz.example/join to claim your bonus wallet.",
};
const LOOKALIKE: BayesMail = {
  subject: "Your crypto bonus is waiting",
  fromEmail: "offers@tokenpump.example",
  html: "<p>Claim your exclusive bitcoin bonus now. Guaranteed profits from our trading signals, double your investment. <a href=\"https://coinz.example/vip\">Join</a></p>",
  text: null,
};
const OTHER_SPAM: BayesMail = {
  subject: "Cheap pills online",
  fromEmail: "sales@pharma.example",
  html: null,
  text: "Buy cheap pills online without prescription, discreet shipping worldwide, lowest prices guaranteed.",
};

async function seedMessages(db: Db, n: number): Promise<string[]> {
  const box = await seedMailbox(db, { orgId: "org-bayes" });
  const threadId = await seedThread(db, box);
  const rows = Array.from({ length: n }, () => messageRow(box, threadId));
  for (const row of rows) await db.insert(messages).values(row);
  return rows.map((r) => r.id!);
}

async function snapshot(db: Db) {
  const rows = await db.select({ token: spamTokens.token, spam: spamTokens.spamCount, ham: spamTokens.hamCount }).from(spamTokens);
  return Object.fromEntries(rows.map((r) => [r.token, [r.spam, r.ham]]));
}

describe("naive Bayes", () => {
  beforeEach(async () => {
    const db = createDb(env);
    await db.delete(spamTraining);
    await db.delete(spamTokens);
  });

  it("learns from a spam click", async () => {
    const db = createDb(env);
    const [h1, h2, h3, s1, s2] = await seedMessages(db, 5);
    expect(await score(db, LOOKALIKE)).toMatchObject({ logOdds: 0, probability: 0.5, spamMessages: 0, hamMessages: 0 });

    await learn(db, h1!, "ham", HAM[0]!);
    await learn(db, h2!, "ham", HAM[1]!);
    await learn(db, h3!, "ham", HAM[2]!);
    await learn(db, s1!, "spam", OTHER_SPAM);
    const before = await score(db, LOOKALIKE);
    expect(before.spamMessages).toBe(1);
    expect(before.hamMessages).toBe(3);
    expect(before.probability).toBeLessThan(0.7);

    expect(await learn(db, s2!, "spam", SPAM)).toBe("learned");
    const after = await score(db, LOOKALIKE);
    expect(after.spamMessages).toBe(2);
    expect(after.logOdds).toBeGreaterThan(before.logOdds + 3);
    expect(after.probability).toBeGreaterThan(0.95);
    const decisive = after.tokens.map((t) => t.token);
    const learned = new Set(tokenize(SPAM));
    const spammy = after.tokens.filter((t) => t.f > 0.5).map((t) => t.token);
    expect(spammy).toEqual(expect.arrayContaining(["bitcoin", "guaranteed", "subject:crypto", "url:coinz.example"]));
    expect(spammy.every((t) => learned.has(t))).toBe(true);
    expect(after.tokens.find((t) => t.token === "from")?.f).toBeLessThan(0.5);

    const ham = await score(db, { subject: "Notes from the planning meeting", fromEmail: "priya@client.example", html: null, text: "Minutes and agenda attached, comments before Friday please." });
    expect(ham.probability).toBeLessThan(0.05);

    const counts = await snapshot(db);
    expect(await learn(db, s2!, "spam", SPAM)).toBe("unchanged");
    expect(await snapshot(db)).toEqual(counts);
    expect(counts["bitcoin"]).toEqual([1, 0]);
  });

  it("unlearn reverses a mistaken label", async () => {
    const db = createDb(env);
    const [h1, h2, s1, wrong] = await seedMessages(db, 4);
    await learn(db, h1!, "ham", HAM[0]!);
    await learn(db, h2!, "ham", HAM[1]!);
    await learn(db, s1!, "spam", SPAM);
    const clean = await snapshot(db);
    const cleanScore = await score(db, HAM[2]!);

    const dinner = HAM[2]!;
    expect(await learn(db, wrong!, "spam", dinner)).toBe("learned");
    expect((await snapshot(db))["saturday"]).toEqual([1, 0]);
    expect((await score(db, dinner)).probability).toBeGreaterThan(0.9);

    expect(await unlearn(db, wrong!, dinner)).toBe(true);
    expect(await snapshot(db)).toEqual(clean);
    expect(await db.select().from(spamTraining).where(eq(spamTraining.messageId, wrong!))).toHaveLength(0);
    expect(await score(db, dinner)).toEqual(cleanScore);
    expect(await unlearn(db, wrong!, dinner)).toBe(false);
    expect(await snapshot(db)).toEqual(clean);

    expect(await learn(db, wrong!, "spam", dinner)).toBe("learned");
    expect(await learn(db, wrong!, "ham", dinner)).toBe("relabelled");
    const relabelled = await snapshot(db);
    expect(relabelled["saturday"]).toEqual([0, 1]);
    expect(relabelled[MESSAGE_COUNT_TOKEN]).toEqual([1, 3]);
    expect((await db.select().from(spamTraining).where(eq(spamTraining.messageId, wrong!)))[0]?.label).toBe("ham");
    expect((await score(db, dinner)).probability).toBeLessThan(0.1);
  });

  it("token counts persist in D1", async () => {
    const db = createDb(env);
    const [s1, h1] = await seedMessages(db, 2);
    await learn(db, s1!, "spam", SPAM);
    await learn(db, h1!, "ham", HAM[0]!);

    const raw = await env.DB.prepare("SELECT token, spam_count, ham_count, updated_at FROM spam_tokens ORDER BY token").all<{
      token: string;
      spam_count: number;
      ham_count: number;
      updated_at: number;
    }>();
    const byToken = new Map(raw.results.map((r) => [r.token, r]));
    expect(byToken.size).toBe(new Set([...tokenize(SPAM), ...tokenize(HAM[0]!)]).size + 1);
    expect(byToken.get(MESSAGE_COUNT_TOKEN)).toMatchObject({ spam_count: 1, ham_count: 1 });
    expect(byToken.get("bitcoin")).toMatchObject({ spam_count: 1, ham_count: 0 });
    expect(byToken.get("subject:crypto")).toMatchObject({ spam_count: 1, ham_count: 0 });
    expect(byToken.get("from:coinz.example")).toMatchObject({ spam_count: 1, ham_count: 0 });
    expect(byToken.get("url:coinz.example")).toMatchObject({ spam_count: 1, ham_count: 0 });
    expect(byToken.get("agenda")).toMatchObject({ spam_count: 0, ham_count: 1 });
    expect(byToken.get("your")).toMatchObject({ spam_count: 1, ham_count: 0 });
    expect(byToken.get("bitcoin")!.updated_at).toBeGreaterThan(0);
    const trained = await env.DB.prepare("SELECT message_id, label FROM spam_training ORDER BY label").all();
    expect(trained.results).toEqual([
      { message_id: h1, label: "ham" },
      { message_id: s1, label: "spam" },
    ]);

    const fresh = createDb({ DB: env.DB });
    const scored = await score(fresh, LOOKALIKE);
    expect(scored).toMatchObject({ spamMessages: 1, hamMessages: 1 });
    expect(scored.probability).toBeGreaterThan(0.9);

    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(s1).run();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM spam_training").first<{ n: number }>())!.n).toBe(1);
  });
});
