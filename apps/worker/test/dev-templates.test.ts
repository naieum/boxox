import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiMessages, domains } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { DevContext } from "../src/dev/auth";
import { createDomainKey } from "../src/dev/keys";
import { devMessageRoutes } from "../src/dev/messages-routes";
import { renderTemplate, type TemplateSource } from "../src/dev/templates";
import { devTemplateRoutes } from "../src/dev/templates-routes";
import type { SendParams } from "../src/env";

/**
 * Templates: the renderer on its own, then /dev/v1/templates and sending with
 * a template against a local D1 and R2 (workerd, via Miniflare) with the real
 * migrations. The Workflows binding is a fake.
 */
const ORG = "owner";
const OWNER = { type: "owner" as const, email: "owner@example.test" };

let DB: D1Database;
let MAIL_STORE: R2Bucket;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  MAIL_STORE = env.MAIL_STORE;
  db = createDb({ DB });
});

const created: { id: string; params: SendParams }[] = [];
const SEND_WORKFLOW = {
  async create(opts: { id: string; params: SendParams }) {
    created.push(opts);
    return { id: opts.id };
  },
} as unknown as Workflow<SendParams>;

const app = new Hono<DevContext>()
  .use("*", async (c, next) => {
    c.set("db", db);
    await next();
  })
  .route("/dev/v1/templates", devTemplateRoutes)
  .route("/dev/v1/messages", devMessageRoutes);

async function seedDomain() {
  const id = crypto.randomUUID();
  const name = `${id.slice(0, 8)}.test`;
  await db.insert(domains).values({ id, organizationId: ORG, name, sendingEnabled: true });
  return { id, name };
}

async function domainKey(domainId: string, permissions: ("send" | "templates" | "read_log")[] = ["send", "templates"]) {
  return (await createDomainKey(db, ORG, OWNER, { name: "app", domainId, permissions })).secret;
}

function call(method: string, path: string, key: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB, MAIL_STORE, SEND_WORKFLOW },
  );
}

const ATTACK = `<script>alert("x")</script><img src=x onerror='y'>`;

describe("template rendering", () => {
  it("escapes variables by default", () => {
    const template: TemplateSource = {
      subject: "Hi {{name}}",
      html: `<p>Hello {{ name }}</p><a title="{{name}}">x</a><p>{{{name}}}</p>`,
      text: "Hello {{name}}",
      variables: [{ name: "name", type: "string", raw: false }],
    };
    const out = renderTemplate(template, { name: ATTACK });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toMatch(/title="[^"]*"[^>]*onerror/);
    expect(out.html).toBe(
      "<p>Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;</p>" +
        '<a title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;">x</a>' +
        "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;</p>",
    );
    // The text part is not HTML, so it gets the value as-is; the subject can't gain header lines.
    expect(out.text).toBe(`Hello ${ATTACK}`);
    expect(renderTemplate(template, { name: "Ann\r\nBcc: evil@example.com" }).subject).toBe("Hi Ann Bcc: evil@example.com");
  });

  it("raw output only for variables declared raw", async () => {
    const template: TemplateSource = {
      subject: "Receipt",
      html: "<div>{{{footer}}}</div><div>{{{note}}}</div><div>{{footer}}</div>",
      text: null,
      variables: [
        { name: "footer", type: "string", raw: true },
        { name: "note", type: "string", raw: false },
      ],
    };
    const out = renderTemplate(template, { footer: "<b>Thanks</b>", note: "<b>bold?</b>" });
    expect(out.html).toBe("<div><b>Thanks</b></div><div>&lt;b&gt;bold?&lt;/b&gt;</div><div>&lt;b&gt;Thanks&lt;/b&gt;</div>");

    // Saving a template that uses {{{x}}} for a non-raw x is refused outright.
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const refused = await call("POST", "/dev/v1/templates", key, {
      name: "receipt",
      html: "<div>{{{note}}}</div>",
      variables: [{ name: "note" }],
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("raw_not_declared");

    const ok = await call("POST", "/dev/v1/templates", key, {
      name: "receipt",
      html: "<div>{{{footer}}}</div>",
      variables: [{ name: "footer", raw: true }],
    });
    expect(ok.status).toBe(201);
    const preview = await call("POST", "/dev/v1/templates/receipt/preview", key, { variables: { footer: "<i>ok</i>" } });
    expect(((await preview.json()) as { html: string }).html).toBe("<div><i>ok</i></div>");
  });

  it("fallback values fill missing variables", () => {
    const template: TemplateSource = {
      subject: "{{greeting}}, {{name}}",
      html: "<p>{{greeting}}, {{name}}. You have {{count}} new. Pro: {{pro}}</p>",
      text: null,
      variables: [
        { name: "greeting", type: "string", fallback: "Hello", raw: false },
        { name: "name", type: "string", fallback: "<friend>", raw: false },
        { name: "count", type: "number", fallback: 0, raw: false },
        { name: "pro", type: "boolean", raw: false },
      ],
    };
    const out = renderTemplate(template, { name: "Ann", pro: true });
    expect(out.subject).toBe("Hello, Ann");
    expect(out.html).toBe("<p>Hello, Ann. You have 0 new. Pro: true</p>");
    expect(out.text).toBe("Hello, Ann. You have 0 new. Pro: true");

    // Fallbacks are escaped like any other value; null counts as missing.
    expect(renderTemplate(template, { name: null, pro: false }).html).toContain("Hello, &lt;friend&gt;.");

    // No value and no fallback is an error, not an empty string.
    expect(() => renderTemplate(template, { name: "Ann" })).toThrow(expect.objectContaining({ code: "missing_variable" }));
  });

  it("checks variable types and rejects unknown variables", () => {
    const template: TemplateSource = {
      subject: "",
      html: '<a href="{{link}}">Go</a> {{count}}',
      text: null,
      variables: [
        { name: "link", type: "url", raw: false },
        { name: "count", type: "number", raw: false },
      ],
    };
    expect(renderTemplate(template, { link: "https://example.com/?a=1&b=2", count: 3 }).html).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">Go</a> 3',
    );
    expect(() => renderTemplate(template, { link: "javascript:alert(1)", count: 3 })).toThrow(
      expect.objectContaining({ code: "invalid_variable" }),
    );
    expect(() => renderTemplate(template, { link: "https://example.com", count: "3" })).toThrow(
      expect.objectContaining({ code: "invalid_variable" }),
    );
    expect(() => renderTemplate(template, { link: "https://example.com", count: 3, extra: "x" })).toThrow(
      expect.objectContaining({ code: "unknown_variable" }),
    );
  });
});

describe("/dev/v1/templates", () => {
  it("each save is a new version and old versions stay readable", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const v1 = await call("POST", "/dev/v1/templates", key, {
      name: "welcome",
      subject: "Welcome {{name}}",
      html: "<p>Hi {{name}}</p>",
      variables: [{ name: "name", fallback: "there" }],
    });
    expect(v1.status).toBe(201);
    expect(((await v1.json()) as { version: number }).version).toBe(1);

    const dup = await call("POST", "/dev/v1/templates", key, { name: "welcome", text: "x" });
    expect(dup.status).toBe(409);

    const v2 = await call("PUT", "/dev/v1/templates/welcome", key, {
      subject: "Welcome aboard {{name}}",
      html: "<p>Hey {{name}}</p>",
      variables: [{ name: "name", fallback: "there" }],
    });
    expect(((await v2.json()) as { version: number }).version).toBe(2);

    const latest = (await (await call("GET", "/dev/v1/templates/welcome", key)).json()) as { version: number; html: string };
    expect(latest).toMatchObject({ version: 2, html: "<p>Hey {{name}}</p>" });
    const old = (await (await call("GET", "/dev/v1/templates/welcome?version=1", key)).json()) as { version: number; html: string };
    expect(old).toMatchObject({ version: 1, html: "<p>Hi {{name}}</p>" });

    const versions = (await (await call("GET", "/dev/v1/templates/welcome/versions", key)).json()) as { data: { version: number; html: string }[] };
    expect(versions.data.map((v) => [v.version, v.html])).toEqual([
      [2, "<p>Hey {{name}}</p>"],
      [1, "<p>Hi {{name}}</p>"],
    ]);
    const list = (await (await call("GET", "/dev/v1/templates", key)).json()) as { data: { name: string; version: number }[] };
    expect(list.data).toEqual([expect.objectContaining({ name: "welcome", version: 2 })]);
    await call("POST", "/dev/v1/templates", key, { name: "zeta", html: "<p>z</p>", text: null });
    const page1 = (await (await call("GET", "/dev/v1/templates?limit=1", key)).json()) as { data: { name: string }[]; nextCursor: string };
    expect(page1).toMatchObject({ data: [{ name: "welcome" }], nextCursor: "welcome" });
    const page2 = (await (await call("GET", "/dev/v1/templates?limit=1&cursor=welcome", key)).json()) as { data: { name: string }[]; nextCursor: null };
    expect(page2).toMatchObject({ data: [{ name: "zeta" }], nextCursor: null });

    const preview = await call("POST", "/dev/v1/templates/welcome/preview", key, { version: 1, variables: { name: "<Ann>" } });
    expect(await preview.json()).toMatchObject({ version: 1, subject: "Welcome <Ann>", html: "<p>Hi &lt;Ann&gt;</p>", text: "Hi <Ann>" });

    const undeclared = await call("PUT", "/dev/v1/templates/welcome", key, { html: "<p>{{who}}</p>" });
    expect(undeclared.status).toBe(422);

    const del = await call("DELETE", "/dev/v1/templates/welcome", key);
    expect(await del.json()).toMatchObject({ deleted: true, versions: 2 });
    expect((await call("GET", "/dev/v1/templates/welcome", key)).status).toBe(404);
  });

  it("templates are scoped to the key's domain and need the templates permission", async () => {
    const a = await seedDomain();
    const b = await seedDomain();
    const keyA = await domainKey(a.id);
    const keyB = await domainKey(b.id);
    const sendOnly = await domainKey(a.id, ["send"]);
    await call("POST", "/dev/v1/templates", keyA, { name: "secret", text: "for A only" });

    expect((await call("GET", "/dev/v1/templates/secret", keyB)).status).toBe(404);
    expect((await call("PUT", "/dev/v1/templates/secret", keyB, { text: "hijack" })).status).toBe(404);
    expect((await call("DELETE", "/dev/v1/templates/secret", keyB)).status).toBe(404);
    expect(((await (await call("GET", "/dev/v1/templates", keyB)).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await call("GET", "/dev/v1/templates", sendOnly)).status).toBe(403);

    // B may not send with A's template either.
    const send = await call("POST", "/dev/v1/messages", keyB, {
      from: `app@${b.name}`,
      to: "person@example.com",
      template: "secret",
    });
    expect(send.status).toBe(404);
    expect((await call("GET", "/dev/v1/templates/secret", keyA)).status).toBe(200);
  });

  it("sends a message rendered from a template", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const tpl = (await (
      await call("POST", "/dev/v1/templates", key, {
        name: "order",
        subject: "Order {{id}}",
        html: "<p>Order {{id}} for {{name}}</p>",
        variables: [{ name: "id", type: "number" }, { name: "name" }],
      })
    ).json()) as { id: string };

    const res = await call("POST", "/dev/v1/messages", key, {
      from: `shop@${d.name}`,
      to: "person@example.com",
      template: "order",
      variables: { id: 42, name: "<b>Ann</b>" },
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db.select().from(apiMessages).where(eq(apiMessages.id, id));
    expect(row).toMatchObject({ subject: "Order 42", templateId: tpl.id });
    const stored = (await (await MAIL_STORE.get(row!.r2Key))!.json()) as { html: string; text: string };
    expect(stored.html).toBe("<p>Order 42 for &lt;b&gt;Ann&lt;/b&gt;</p>");
    expect(stored.text).toBe("Order 42 for <b>Ann</b>");

    const missing = await call("POST", "/dev/v1/messages", key, {
      from: `shop@${d.name}`,
      to: "person@example.com",
      template: "order",
      variables: { id: 1 },
    });
    expect(missing.status).toBe(422);
    const both = await call("POST", "/dev/v1/messages", key, {
      from: `shop@${d.name}`,
      to: "person@example.com",
      template: "order",
      html: "<p>x</p>",
      variables: { id: 1, name: "x" },
    });
    expect(both.status).toBe(400);
  });
});
