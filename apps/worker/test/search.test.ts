import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { messages } from "@boxox/db";
import { createDb, ftsQuery, searchThreads, type Db } from "../src/db";
import { SEARCH_TEXT_LIMIT, buildSearchText, searchTextLimit } from "../src/services/ingest";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * v1's Postgres tsvector suite, ported to threads_fts (FTS5) on a local D1.
 * FTS5 has no stemmer here (unicode61), so v1's stemming case becomes prefix
 * matching, and operator syntax is neutralised by ftsQuery instead of
 * websearch_to_tsquery.
 */
describe("buildSearchText", () => {
  const base = {
    subject: "Q3 invoice",
    fromEmail: "ada@lovelace.test",
    fromName: "Ada Lovelace",
    toEmails: ["ops@acme.test"],
    ccEmails: [],
    text: "Please find the invoice attached.",
    html: null,
  };

  it("includes participants, not just content", () => {
    // "everything from Ada" is at least as common a search as any body word.
    const out = buildSearchText(base);
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("ada@lovelace.test");
    expect(out).toContain("ops@acme.test");
    expect(out).toContain("Q3 invoice");
  });

  it("strips tags when only HTML is available", () => {
    const out = buildSearchText({ ...base, text: null, html: "<p>hello <b>world</b></p>" });
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("<b>");
  });

  it("truncates so one large newsletter cannot dominate a row", () => {
    const out = buildSearchText({ ...base, text: "x".repeat(SEARCH_TEXT_LIMIT * 2) });
    expect(out.length).toBe(SEARCH_TEXT_LIMIT);
  });

  it("accepts bounded installation search budgets including zero", () => {
    expect(buildSearchText(base, 12)).toHaveLength(12);
    expect(buildSearchText(base, 0)).toBe("");
    expect(searchTextLimit("0")).toBe(0);
    expect(searchTextLimit("65536")).toBe(65536);
    for (const value of [undefined, "", "-1", "65537", "NaN", "1.5"]) expect(searchTextLimit(value)).toBe(SEARCH_TEXT_LIMIT);
  });

  it("collapses whitespace so formatting does not fragment tokens", () => {
    const out = buildSearchText({ ...base, text: "a\n\n\t  b" });
    expect(out).toContain("a b");
  });

  it("handles a message with no body at all", () => {
    expect(buildSearchText({ ...base, text: null, html: null })).toBe(
      "Q3 invoice Ada Lovelace ada@lovelace.test ops@acme.test",
    );
  });
});

describe("ftsQuery", () => {
  it("turns each word into a required prefix term", () => {
    expect(ftsQuery("invoice Ada")).toBe('"invoice"* "Ada"*');
  });

  it("drops FTS5 operators and punctuation so user input cannot be a syntax error", () => {
    expect(ftsQuery('"* OR NEAR( title:x -y')).toBe('"OR"* "NEAR"* "title"* "x"* "y"*');
    for (const q of ["&&&", "|", "!", "(", '"', "  "]) expect(ftsQuery(q)).toBeNull();
  });

  it("caps the number of terms", () => {
    const terms = ftsQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "))!.split(" ");
    expect(terms).toHaveLength(16);
  });
});

describe("full-text search (threads_fts)", () => {
  let db: Db;
  let mailbox: Awaited<ReturnType<typeof seedMailbox>>;
  const threadOf: Record<string, string> = {};

  beforeAll(async () => {
    db = createDb(env);
    mailbox = await seedMailbox(db, { orgId: "srch", domain: "s.test" });
    for (const [key, subject, text] of [
      ["invoice", "Q3 invoice", "Q3 invoice from Ada Lovelace ada@lovelace.test please pay promptly"],
      ["lunch", "Lunch", "lunch plans with Bob bob@other.test taco tuesday"],
    ] as const) {
      const threadId = await seedThread(db, mailbox, { subject });
      threadOf[key] = threadId;
      await db.insert(messages).values(messageRow(mailbox, threadId, { subject, searchText: text }));
    }
  });

  const search = async (query: string, addressIds: string[] | null = [mailbox.addressId]) =>
    (await searchThreads(db, { query, addressIds })).map((h) => h.threadId);

  it("matches a word in the body", async () => {
    expect(await search("promptly")).toEqual([threadOf.invoice]);
  });

  it("matches word prefixes", async () => {
    expect(await search("prom")).toEqual([threadOf.invoice]);
    expect(await search("tues")).toEqual([threadOf.lunch]);
  });

  it("matches by participant address", async () => {
    expect(await search("bob@other.test")).toEqual([threadOf.lunch]);
  });

  it("requires every term", async () => {
    expect(await search("taco tuesday")).toEqual([threadOf.lunch]);
    expect(await search("taco invoice")).toEqual([]);
  });

  it("returns nothing rather than erroring on malformed operator soup", async () => {
    for (const q of ["&&&", "|", "!", "( unbalanced", '"', "NEAR(", "a AND OR NOT"]) {
      await expect(search(q)).resolves.toBeInstanceOf(Array);
    }
    expect(await search("( unbalanced")).toEqual([]);
  });

  it("does not match across organizations or mailboxes", async () => {
    const other = await seedMailbox(db, { orgId: "srch2", domain: "s2.test" });
    expect(await search("invoice", [other.addressId])).toEqual([]);
    expect(await search("invoice", [])).toEqual([]);
    // The owner's unscoped search does see it.
    expect(await search("invoice", null)).toEqual([threadOf.invoice]);
  });

  it("ranks subject matches above body-only matches", async () => {
    const bodyOnly = await seedThread(db, mailbox, { subject: "Misc" });
    await db.insert(messages).values(messageRow(mailbox, bodyOnly, { subject: "Misc", searchText: "the quarterly report is late" }));
    const subject = await seedThread(db, mailbox, { subject: "Quarterly report" });
    await db.insert(messages).values(messageRow(mailbox, subject, { subject: "Quarterly report", searchText: "see attached" }));
    expect(await search("quarterly")).toEqual([subject, bodyOnly]);
  });

  it("uses the FTS5 index rather than scanning messages", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT thread_id FROM threads_fts WHERE threads_fts MATCH ?",
    )
      .bind('"invoice"*')
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join("\n");
    expect(detail).toMatch(/VIRTUAL TABLE INDEX/);
    expect(detail).not.toMatch(/SCAN messages/);
  });
});
