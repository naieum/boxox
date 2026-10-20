import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import { createDb } from "../src/db";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";
import { describe, expect, it } from "vitest";
import { collectR2Keys, RETENTION_TRASH_DAYS, runRetentionPurge } from "../src/services/retention";

describe("RETENTION_TRASH_DAYS", () => {
  it("is the 30-day standard trash window", () => {
    expect(RETENTION_TRASH_DAYS).toBe(30);
  });
});

describe("collectR2Keys", () => {
  it("returns an empty list for no rows", () => {
    expect(collectR2Keys([])).toEqual([]);
  });

  it("collects payload key plus every attachment key", () => {
    const keys = collectR2Keys([
      {
        rawMimeKey: null,
        r2Key: "raw/org/msg.json",
        attachmentsMeta: [{ r2Key: "attachments/org/msg/0-a.pdf" }, { r2Key: "attachments/org/msg/1-b.png" }],
      },
    ]);
    expect(keys.sort()).toEqual([
      "attachments/org/msg/0-a.pdf",
      "attachments/org/msg/1-b.png",
      "raw/org/msg.json",
    ]);
  });

  it("dedups keys shared across rows", () => {
    const keys = collectR2Keys([
      { rawMimeKey: null, r2Key: "raw/shared.json", attachmentsMeta: [{ rawMimeKey: null, r2Key: "att/dup.bin" }] },
      { rawMimeKey: null, r2Key: "raw/shared.json", attachmentsMeta: [{ rawMimeKey: null, r2Key: "att/dup.bin" }] },
    ]);
    expect(keys).toEqual(["raw/shared.json", "att/dup.bin"]);
  });

  it("skips a null r2Key and truncated/absent attachment keys", () => {
    const keys = collectR2Keys([
      // Null payload key — nothing to collect from this row's r2Key.
      { rawMimeKey: null, r2Key: null, attachmentsMeta: [] },
      // Truncated attachment metadata: missing/empty/non-string r2Key.
      {
        rawMimeKey: null,
        r2Key: "raw/keep.json",
        attachmentsMeta: [{ r2Key: undefined }, { r2Key: "" }, { r2Key: 42 }, { filename: "x" }],
      },
    ]);
    expect(keys).toEqual(["raw/keep.json"]);
  });

  it("tolerates non-array attachmentsMeta", () => {
    const keys = collectR2Keys([{ rawMimeKey: null, r2Key: "raw/only.json", attachmentsMeta: null }]);
    expect(keys).toEqual(["raw/only.json"]);
  });

  it("derives the raw webhook sibling for a fetched-body payload", () => {
    // Fetched-body messages point at `X.full.json`; the original raw webhook
    // at `X.json` is referenced by no row and must be purged alongside it.
    const keys = collectR2Keys([
      { rawMimeKey: null, r2Key: "ingest/org/2026-07-01/u.full.json", attachmentsMeta: [] },
    ]);
    expect(keys.sort()).toEqual([
      "ingest/org/2026-07-01/u.full.json",
      "ingest/org/2026-07-01/u.json",
    ]);
  });

  it("includes normalized attachment bytes and canonical/cache text keys without legacy metadata", () => {
    const hash = "d".repeat(64);
    expect(collectR2Keys([], [{ sha256: hash, textR2Key: null }]).sort()).toEqual([`att-text/${hash}.md`, `att/${hash}`]);
    expect(collectR2Keys([], [{ sha256: hash, textR2Key: "legacy/conversion.md" }])).toContain("legacy/conversion.md");
  });

  it("does not derive a sibling for an inline-body payload", () => {
    const keys = collectR2Keys([{ rawMimeKey: null, r2Key: "ingest/org/2026-07-01/u.json", attachmentsMeta: [] }]);
    expect(keys).toEqual(["ingest/org/2026-07-01/u.json"]);
  });
});

describe("collectR2Keys — original MIME", () => {
  it("includes the original .eml so a purge cannot orphan it", () => {
    // The .eml holds the COMPLETE message including every attachment. Omitting
    // it meant a purged thread left the largest and most sensitive artifact in
    // R2 with no row referencing it: unreachable, unenumerable, and impossible
    // to erase on request.
    const keys = collectR2Keys([
      {
        rawMimeKey: "originals/org/2026-07-24/em_1.eml",
        r2Key: "ingest/org/2026-07-24/x.full.json",
        attachmentsMeta: [{ r2Key: "attachments/org/2026-07-24/em_1/a1-doc.pdf" }],
      },
    ]);
    expect(keys).toContain("originals/org/2026-07-24/em_1.eml");
    expect(keys).toContain("ingest/org/2026-07-24/x.full.json");
    expect(keys).toContain("ingest/org/2026-07-24/x.json");
    expect(keys).toContain("attachments/org/2026-07-24/em_1/a1-doc.pdf");
  });

  it("deduplicates one .eml shared across copies of the same email", () => {
    // Every routed and held copy points at the same original.
    const shared = "originals/org/2026-07-24/em_1.eml";
    const keys = collectR2Keys([
      { rawMimeKey: shared, r2Key: "a.json", attachmentsMeta: [] },
      { rawMimeKey: shared, r2Key: "b.json", attachmentsMeta: [] },
    ]);
    expect(keys.filter((k) => k === shared)).toHaveLength(1);
  });

  it("skips a null original without dropping the rest of the row", () => {
    const keys = collectR2Keys([
      { rawMimeKey: null, r2Key: "only.json", attachmentsMeta: [] },
    ]);
    expect(keys).toEqual(["only.json"]);
  });
});


it("R2 objects are deleted only after the trash window ends", async () => {
  const db = createDb(env);
  const box = await seedMailbox(db, { orgId: "retention-boundary" });
  const threadId = await seedThread(db, box, { folder: "trash", updatedAt: new Date() });
  const row = messageRow(box, threadId);
  await db.insert(messages).values(row);
  await env.MAIL_STORE.put(row.r2Key, "synthetic retained message");
  await runRetentionPurge({ ...env, VECTORS: undefined });
  expect(await env.MAIL_STORE.head(row.r2Key)).not.toBeNull();
  expect(await db.query.messages.findFirst({ where: eq(messages.id, row.id!) })).toBeDefined();
  await db.update(threads).set({ updatedAt: new Date(Date.now() - (RETENTION_TRASH_DAYS + 1) * 86400000) }).where(eq(threads.id, threadId));
  await runRetentionPurge({ ...env, VECTORS: undefined });
  expect(await env.MAIL_STORE.head(row.r2Key)).toBeNull();
  expect(await db.query.messages.findFirst({ where: eq(messages.id, row.id!) })).toBeUndefined();
});
