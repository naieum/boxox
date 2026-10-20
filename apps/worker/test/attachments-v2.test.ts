import { env } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { addresses, aiSettings, attachments, messages } from "@boxox/db";
import { createDb } from "../src/db";
import { inboundRawKey } from "../src/email";
import type { Env } from "../src/env";
import type { AppContext, SessionUser } from "../src/middleware";
import { attachmentRoutes } from "../src/routes/attachments";
import { threadRoutes } from "../src/routes/threads";
import {
  classifyRisk,
  cleanFilename,
  describeAttachment,
  detectType,
  hasDoubleExtension,
  readZipDirectory,
  rewriteCidImages,
} from "../src/services/attachments";
import { runIngest, type IngestStep } from "../src/services/ingest/run";
import { id, seedMailbox } from "./helpers/seed";

/**
 * Inbound attachments on real D1 and R2: messages go through runIngest, and
 * downloads through the attachment route as the owner would fetch them.
 * toMarkdown is a fake that records what it is handed; nothing reaches a model.
 */
const db = createDb(env);
const enc = new TextEncoder();

const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const MEMBER: SessionUser = { id: "member@example.test", email: "member@example.test", name: "Member", role: "member" };

function appAs(user: SessionUser) {
  return new Hono<AppContext>()
    .use("*", async (c, next) => {
      c.set("db", createDb(c.env));
      c.set("user", user);
      await next();
    })
    .route("/api/orgs/:orgId/threads", threadRoutes)
    .route("/api/orgs/:orgId/attachments", attachmentRoutes);
}
const owner = appAs(OWNER);

const toMarkdown = vi.fn(async (file: { name: string; blob: Blob }) => ({
  id: id(),
  name: file.name,
  mimeType: file.blob.type,
  format: "markdown" as const,
  tokens: 3,
  data: `# ${file.name}\n\nconverted ${(await file.blob.arrayBuffer()).byteLength} bytes`,
}));
const testEnv = () => ({ ...env, AI: { toMarkdown, run: vi.fn() } }) as unknown as Env;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const PDF = enc.encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
const HTML = enc.encode("<!DOCTYPE html><html><body><script>fetch('/api/orgs/x/export')</script></body></html>");
const SVG = enc.encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"><circle r="4"/></svg>');

/** A stored (uncompressed) zip; `claimSize` fakes an entry's uncompressed size, as a zip bomb would. */
function zip(entries: { name: string; data: Uint8Array; claimSize?: number; encrypted?: boolean }[]): Uint8Array {
  const chunks: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], v: number) => out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (out: number[], v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const e of entries) {
    const name = [...enc.encode(e.name)];
    const offset = chunks.length;
    const flags = e.encrypted ? 1 : 0;
    u32(chunks, 0x04034b50); u16(chunks, 20); u16(chunks, flags); u16(chunks, 0); u16(chunks, 0); u16(chunks, 0);
    u32(chunks, 0); u32(chunks, e.data.length); u32(chunks, e.claimSize ?? e.data.length); u16(chunks, name.length); u16(chunks, 0);
    chunks.push(...name, ...e.data);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, flags); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, e.data.length); u32(central, e.claimSize ?? e.data.length); u16(central, name.length);
    u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, offset);
    central.push(...name);
  }
  const cdOffset = chunks.length;
  const eocd: number[] = [];
  u32(eocd, 0x06054b50); u16(eocd, 0); u16(eocd, 0); u16(eocd, entries.length); u16(eocd, entries.length);
  u32(eocd, central.length); u32(eocd, cdOffset); u16(eocd, 0);
  return new Uint8Array([...chunks, ...central, ...eocd]);
}

interface Part {
  filename: string;
  type: string;
  bytes: Uint8Array;
  cid?: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/.{76}/g, "$&\r\n");
}

/** multipart/mixed, or multipart/related when a part has a Content-ID. */
function mime(to: string, html: string, parts: Part[]): Uint8Array {
  const boundary = `b-${id()}`;
  const kind = parts.some((p) => p.cid) ? "related" : "mixed";
  const lines = [
    "From: Sender <sender@ext.test>",
    `To: ${to}`,
    `Subject: Files ${id()}`,
    `Message-ID: <${id()}@ext.test>`,
    "Date: Sat, 17 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/${kind}; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  for (const p of parts) {
    const encodedName = `filename*=UTF-8''${encodeURIComponent(p.filename)}`;
    lines.push(
      `--${boundary}`,
      `Content-Type: ${p.type}`,
      "Content-Transfer-Encoding: base64",
      p.cid ? `Content-Disposition: inline; ${encodedName}` : `Content-Disposition: attachment; ${encodedName}`,
      ...(p.cid ? [`Content-ID: <${p.cid}>`] : []),
      "",
      b64(p.bytes),
    );
  }
  lines.push(`--${boundary}--`, "");
  return enc.encode(lines.join("\r\n"));
}

const onceStep = { do: (_name: string, _cfg: unknown, fn: () => Promise<unknown>) => fn() } as unknown as IngestStep;
/** Every step runs twice, like a step retried after its write landed. */
const twiceStep = {
  async do(_name: string, _cfg: unknown, fn: () => Promise<unknown>) {
    await fn();
    return fn();
  },
} as unknown as IngestStep;

let mailbox: { orgId: string; addressId: string; to: string };

beforeAll(async () => {
  const orgId = `org-${id()}`;
  const domain = `${id()}.test`;
  const seeded = await seedMailbox(db, { orgId, domain, localPart: "ann" });
  mailbox = { orgId, addressId: seeded.addressId, to: `ann@${domain}` };
});

async function receive(parts: Part[], html = "<p>see attached</p>", step: IngestStep = onceStep) {
  const receivedAt = new Date();
  const rawKey = inboundRawKey(receivedAt);
  await env.MAIL_STORE.put(rawKey, mime(mailbox.to, html, parts), { customMetadata: { to: mailbox.to, from: "sender@ext.test" } });
  const result = await runIngest(env, { rawKey, receivedAt: receivedAt.toISOString() }, step);
  if (result.status !== "stored") throw new Error(`not stored: ${result.status}`);
  const rows = await db.select().from(attachments).where(eq(attachments.messageId, result.messageId)).orderBy(attachments.id);
  return { ...result, rows };
}

const get = (path: string, app = owner) => app.request(`/api/orgs/${mailbox.orgId}/attachments/${path}`, {}, testEnv());

async function attKeys(): Promise<string[]> {
  const listed = await env.MAIL_STORE.list({ prefix: "att" });
  return listed.objects.map((o) => o.key);
}

describe("attachment types", () => {
  it("detected type wins over the declared type", async () => {
    expect(detectType(PNG, "scan.pdf")).toBe("image/png");
    expect(detectType(EXE, "invoice.pdf")).toBe("application/x-msdownload");
    expect(detectType(SVG, "logo.png")).toBe("image/svg+xml");
    expect(detectType(enc.encode("name,amount\nann,4\n"), "rows.csv")).toBe("text/csv");
    expect(detectType(new Uint8Array([0, 1, 2, 3, 0xff]), "x.txt")).toBe("application/octet-stream");

    // HTML posing as a photo: stored and served as what it is.
    const { rows } = await receive([{ filename: "photo.png", type: "image/png", bytes: HTML }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: "photo.png", declaredType: "image/png", detectedType: "text/html", risk: "dangerous" });

    const res = await get(`${rows[0]!.id}?inline=1&accept_risk=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(HTML);

    // A real PDF sent as octet-stream is still a PDF.
    const pdf = await describeAttachment({ filename: "q3.pdf", contentType: "application/octet-stream", content: PDF });
    expect(pdf).toMatchObject({ declaredType: "application/octet-stream", detectedType: "application/pdf", risk: "safe" });
  });

  it("strips bidirectional-override characters from filenames", async () => {
    expect(cleanFilename("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(cleanFilename("⁦report⁩​.pdf")).toBe("report.pdf");
    expect(cleanFilename("..\\..\\Windows\\evil.bat")).toBe("evil.bat");
    expect(cleanFilename("a\u0000b\r\nc.txt")).toBe("abc.txt");
    expect(cleanFilename("run.exe. . .")).toBe("run.exe");
    expect(cleanFilename("‮")).toBe("attachment");

    // The override hides ".exe" as "fdp" reversed; once it's gone the real extension decides the risk.
    const { rows } = await receive([{ filename: "invoice‮fdp.exe", type: "application/pdf", bytes: EXE }]);
    expect(rows[0]!.filename).toBe("invoicefdp.exe");
    expect(rows[0]!.filename).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(rows[0]!.risk).toBe("dangerous");

    const res = await get(`${rows[0]!.id}?accept_risk=1`);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="invoicefdp.exe"; filename*=UTF-8''invoicefdp.exe`);
  });

  it("flags double extensions as dangerous", async () => {
    expect(hasDoubleExtension("invoice.pdf.exe")).toBe(true);
    expect(hasDoubleExtension(cleanFilename("invoice.pdf          .exe"))).toBe(true);
    expect(hasDoubleExtension("backup.tar.gz")).toBe(false);
    expect(hasDoubleExtension("data.csv.zip")).toBe(false);
    expect(hasDoubleExtension("photo.2024.jpg")).toBe(false);

    // Plain bytes and an extension nothing else knows: only the double extension marks it.
    const plain = enc.encode("hello");
    expect(classifyRisk({ filename: "statement.pdf.qzx", detectedType: detectType(plain) })).toBe("dangerous");
    expect(classifyRisk({ filename: "statement.qzx", detectedType: detectType(plain) })).toBe("previewable");
    expect(classifyRisk({ filename: "photo.2024.png", detectedType: "image/png" })).toBe("safe");

    const { rows } = await receive([
      { filename: "invoice.pdf.js", type: "application/pdf", bytes: enc.encode("WScript.Echo(1)") },
      { filename: "notes.docx.qzx", type: "application/octet-stream", bytes: plain },
    ]);
    expect(rows.map((r) => r.risk)).toEqual(["dangerous", "dangerous"]);
    // Dangerous files only download behind an explicit acknowledgement.
    const blocked = await get(rows[1]!.id);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("dangerous_attachment");
  });

  it("classes macro-enabled Office, disk images and encrypted zips as dangerous", () => {
    const docm = zip([
      { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
      { name: "word/document.xml", data: enc.encode("<w:document/>") },
      { name: "word/vbaProject.bin", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(detectType(docm, "report.docx")).toBe("application/vnd.ms-word.document.macroEnabled.12");
    expect(classifyRisk({ filename: "report.docx", detectedType: detectType(docm, "report.docx") })).toBe("dangerous");

    const docx = zip([
      { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
      { name: "word/document.xml", data: enc.encode("<w:document/>") },
    ]);
    expect(classifyRisk({ filename: "report.docx", detectedType: detectType(docx) })).toBe("previewable");

    const iso = new Uint8Array(0x8001 + 5);
    iso.set(enc.encode("CD001"), 0x8001);
    expect(classifyRisk({ filename: "photos.zip", detectedType: detectType(iso, "photos.zip") })).toBe("dangerous");

    const locked = zip([{ name: "invoice.pdf", data: new Uint8Array(12), encrypted: true }]);
    expect(readZipDirectory(locked)?.encrypted).toBe(true);
    expect(classifyRisk({ filename: "invoice.zip", detectedType: detectType(locked), encrypted: true })).toBe("dangerous");
  });
});

describe("attachment downloads", () => {
  it("serves html and svg attachments with CSP sandbox and as attachment", async () => {
    const { rows } = await receive([
      { filename: "page.html", type: "text/html", bytes: HTML },
      { filename: "logo.svg", type: "image/svg+xml", bytes: SVG },
      { filename: "dot.png", type: "image/png", bytes: PNG },
    ]);
    const [html, svg, png] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
    expect([html.risk, svg.risk, png.risk]).toEqual(["dangerous", "dangerous", "safe"]);

    for (const [row, type] of [[html, "text/html"], [svg, "image/svg+xml"]] as const) {
      // Even when inline is asked for, these only ever download.
      const res = await get(`${row.id}?inline=1&accept_risk=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(type);
      expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="/);
    }

    const image = await get(`${png.id}?inline=1`);
    expect(image.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(image.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(image.headers.get("Content-Type")).toBe("image/png");
    const download = await get(png.id);
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("refuses other orgs and members without a grant", async () => {
    const { rows } = await receive([{ filename: "dot.png", type: "image/png", bytes: PNG }]);
    const otherOrg = await owner.request(`/api/orgs/org-${id()}/attachments/${rows[0]!.id}`, {}, testEnv());
    expect(otherOrg.status).toBe(404);
    const member = await get(rows[0]!.id, appAs(MEMBER));
    expect(member.status).toBe(403);
  });

  it("stores the same attachment once", async () => {
    const report = enc.encode(`%PDF-1.7\n${id()}\n%%EOF\n`);
    const before = await attKeys();
    const first = await receive([{ filename: "report.pdf", type: "application/pdf", bytes: report }]);
    const second = await receive([{ filename: "Report (copy).pdf", type: "application/octet-stream", bytes: report }], undefined, twiceStep);
    const added = (await attKeys()).filter((k) => !before.includes(k));

    expect(added).toEqual([`att/${first.rows[0]!.sha256}`]);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.sha256).toBe(first.rows[0]!.sha256);
    expect(second.rows[0]!.filename).toBe("Report (copy).pdf");

    // The repeat's bytes aren't counted against the second message.
    const sizes = await db
      .select({ id: messages.id, storedBytes: messages.storedBytes, rawMimeKey: messages.rawMimeKey })
      .from(messages)
      .where(inArray(messages.id, [first.messageId, second.messageId]));
    const raw = async (key: string | null) => (await env.MAIL_STORE.head(key!))!.size;
    const firstRow = sizes.find((s) => s.id === first.messageId)!;
    const secondRow = sizes.find((s) => s.id === second.messageId)!;
    expect(firstRow.storedBytes).toBe((await raw(firstRow.rawMimeKey)) + report.byteLength);
    expect(secondRow.storedBytes).toBe(await raw(secondRow.rawMimeKey));

    for (const row of [first.rows[0]!, second.rows[0]!]) {
      const res = await get(row.id);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(report);
    }
  });

  it("rewrites cid images to authenticated urls", async () => {
    const html = '<p>Hi</p><img src="cid:logo@ext.test" alt="logo"><img src="cid:art@ext.test"><img src="cid:missing@ext.test">';
    const { threadId, rows } = await receive(
      [
        { filename: "logo.png", type: "image/png", bytes: PNG, cid: "logo@ext.test" },
        { filename: "art.svg", type: "image/svg+xml", bytes: SVG, cid: "art@ext.test" },
      ],
      html,
    );
    const logo = rows.find((r) => r.filename === "logo.png")!;
    expect(logo).toMatchObject({ contentId: "logo@ext.test", inline: true });

    const res = await owner.request(`/api/orgs/${mailbox.orgId}/threads/${threadId}`, {}, testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { html: string | null }[] };
    const shown = body.messages[0]!.html!;
    const url = `/api/orgs/${mailbox.orgId}/attachments/${logo.id}?inline=1`;
    expect(shown).toContain(`src="${url}"`);
    expect(shown).not.toContain("cid:logo@ext.test");
    // SVG can carry script, so it is never linked; unknown ids stay dead.
    expect(shown).toContain('src="cid:art@ext.test"');
    expect(shown).toContain('src="cid:missing@ext.test"');

    // The rewritten URL is the authenticated route and serves the image inline.
    const image = await owner.request(url, {}, testEnv());
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect((await get(logo.id, appAs(MEMBER))).status).toBe(403);

    // Content-IDs match without brackets, case or percent-encoding.
    const parts = [{ id: "a1", contentId: "img%1@x", detectedType: "image/jpeg", risk: "safe" as const }];
    expect(rewriteCidImages(`<img src='cid:IMG%251@X'>`, parts, (i) => `/u/${i}`)).toBe(`<img src='/u/a1'>`);
  });
});

describe("attachment text", () => {
  it("does not send opted-out mailbox documents to a provider", async () => {
    await db.insert(aiSettings).values({ id: 1, ai: true, provider: "openai" }).onConflictDoUpdate({ target: aiSettings.id, set: { ai: true, provider: "openai" } });
    const { rows } = await receive([{ filename: "private.pdf", type: "application/pdf", bytes: enc.encode(`%PDF-1.4\n${id()}\n%%EOF`) }]);
    await db.update(addresses).set({ aiOptOut: true }).where(eq(addresses.id, mailbox.addressId));
    toMarkdown.mockClear();
    try {
      const res = await get(`${rows[0]!.id}/text`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { reason: "address-opted-out" } });
      expect(toMarkdown).not.toHaveBeenCalled();
      // Opting out affects processing, not the owner's original download.
      expect((await get(rows[0]!.id)).status).toBe(200);
    } finally {
      await db.update(addresses).set({ aiOptOut: false }).where(eq(addresses.id, mailbox.addressId));
    }
  });

  it("never unpacks archives", async () => {
    // A stored zip whose second entry claims 4 GiB uncompressed, like a zip bomb.
    const archive = zip([
      { name: "invoice.html", data: HTML },
      { name: "huge.bin", data: new Uint8Array(64), claimSize: 0xffffffff },
    ]);
    await db.insert(aiSettings).values({ id: 1, ai: true, provider: "openai" }).onConflictDoUpdate({ target: aiSettings.id, set: { ai: true, provider: "openai" } });
    toMarkdown.mockClear();
    const before = await attKeys();

    const { rows } = await receive([{ filename: "files.zip", type: "application/zip", bytes: archive }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ detectedType: "application/zip", risk: "previewable", size: archive.byteLength });
    // One object, the archive itself: no entry was extracted or stored.
    expect((await attKeys()).filter((k) => !before.includes(k))).toEqual([`att/${rows[0]!.sha256}`]);

    const text = await get(`${rows[0]!.id}/text`);
    expect(text.status).toBe(404);
    expect(((await text.json()) as { error: { reason: string } }).error.reason).toBe("unsupported-type");
    expect(toMarkdown).not.toHaveBeenCalled();

    const res = await get(rows[0]!.id);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(archive);
  });

  it("converts documents with toMarkdown under our own MIME type and never sends images", async () => {
    await db.insert(aiSettings).values({ id: 1, ai: true, provider: "openai" }).onConflictDoUpdate({ target: aiSettings.id, set: { ai: true, provider: "openai" } });
    toMarkdown.mockClear();
    const pdfBytes = enc.encode(`%PDF-1.4\n${id()}\n%%EOF\n`);
    const { rows } = await receive([
      { filename: "q3.pdf", type: "image/png", bytes: pdfBytes },
      { filename: "dot.png", type: "application/pdf", bytes: PNG },
    ]);
    const [pdf, png] = rows as [typeof rows[0], typeof rows[0]];

    const first = await get(`${pdf.id}/text`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { text: string }).text).toContain("# q3.pdf");
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(toMarkdown.mock.calls[0]![0].blob.type).toBe("application/pdf");

    // Converted once per hash; the text is kept in R2 and linked from the row.
    await get(`${pdf.id}/text`);
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(attachments).where(eq(attachments.id, pdf.id));
    expect(row!.textR2Key).toBe(`att-text/${pdf.sha256}.md`);

    const image = await get(`${png.id}/text`);
    expect(image.status).toBe(404);
    expect(toMarkdown).toHaveBeenCalledTimes(1);

    await db.update(aiSettings).set({ ai: false }).where(eq(aiSettings.id, 1));
    const other = await receive([{ filename: "b.pdf", type: "application/pdf", bytes: enc.encode(`%PDF-1.4\n${id()}\n`) }]);
    const off = await get(`${other.rows[0]!.id}/text`);
    expect(((await off.json()) as { error: { reason: string } }).error.reason).toBe("ai-off");
    expect(toMarkdown).toHaveBeenCalledTimes(1);
  });
});
