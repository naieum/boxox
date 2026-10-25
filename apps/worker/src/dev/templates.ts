import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import { templates } from "@boxox/db";
import { z } from "zod";
import type { Db } from "../db";
import type { AuthenticatedKey } from "./keys";
import { htmlToText, MessageError, zodError } from "./messages";

/**
 * /dev/v1/templates: per-domain, versioned. `{{name}}` is HTML-escaped;
 * `{{{name}}}` is raw only for a variable declared `raw: true`, and escaped
 * otherwise. Every variable a template uses must be declared.
 */

export const VARIABLE_TYPES = ["string", "number", "boolean", "url"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];
export const MAX_VARIABLES = 100;
const MAX_BODY_CHARS = 512 * 1024;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG_RE = /\{\{\{\s*([^{}\s]+)\s*\}\}\}|\{\{\s*([^{}\s]+)\s*\}\}/g;

const scalar = z.union([z.string().max(10_000), z.number().finite(), z.boolean()]);

export const variableSchema = z
  .object({
    name: z.string().regex(NAME_RE, "Variable names are letters, digits and underscores").max(64),
    type: z.enum(VARIABLE_TYPES).default("string"),
    fallback: scalar.optional(),
    raw: z.boolean().default(false),
  })
  .strict();

export type TemplateVariable = z.infer<typeof variableSchema>;

export const templateSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Template names are letters, digits, - and _ (up to 64)"),
    subject: z.string().max(998).default(""),
    html: z.string().max(MAX_BODY_CHARS).nullish(),
    text: z.string().max(MAX_BODY_CHARS).nullish(),
    variables: z.array(variableSchema).max(MAX_VARIABLES).default([]),
  })
  .strict();

export const templateUpdateSchema = templateSchema.omit({ name: true });

export type TemplateValues = Record<string, unknown>;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Checks one value against its declared type; returns it as a string. */
function coerce(variable: TemplateVariable, value: unknown): string {
  const bad = () => new MessageError(422, "invalid_variable", `${variable.name} must be a ${variable.type}`, `variables.${variable.name}`);
  switch (variable.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
      return String(value);
    case "boolean":
      if (typeof value !== "boolean") throw bad();
      return String(value);
    case "url": {
      if (typeof value !== "string") throw bad();
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw bad();
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw bad();
      return value;
    }
    default:
      if (typeof value !== "string") throw bad();
      return value;
  }
}

/** Every value the template needs, typed, with fallbacks filled in. */
export function resolveValues(variables: TemplateVariable[], values: TemplateValues = {}): Map<string, string> {
  const declared = new Map(variables.map((v) => [v.name, v]));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) {
      throw new MessageError(422, "unknown_variable", `${name} is not a variable of this template`, `variables.${name}`);
    }
  }
  const resolved = new Map<string, string>();
  for (const v of variables) {
    const given = values[v.name];
    const value = given === undefined || given === null ? v.fallback : given;
    if (value === undefined) {
      throw new MessageError(422, "missing_variable", `${v.name} is required`, `variables.${v.name}`);
    }
    resolved.set(v.name, coerce(v, value));
  }
  return resolved;
}

/**
 * Replaces tags in `source`. In "html", `{{x}}` is escaped and `{{{x}}}` is
 * raw only if x is declared raw. In "text" nothing is escaped (it is not
 * HTML); "header" also drops CR/LF so a value can't add headers.
 */
export function renderString(
  source: string,
  variables: TemplateVariable[],
  values: Map<string, string>,
  mode: "html" | "text" | "header" = "html",
): string {
  const declared = new Map(variables.map((v) => [v.name, v]));
  return source.replace(TAG_RE, (tag, triple: string | undefined, double: string | undefined) => {
    const name = (triple ?? double)!;
    const variable = declared.get(name);
    const value = values.get(name);
    if (!variable || value === undefined) {
      throw new MessageError(422, "unknown_variable", `${name} is not a variable of this template`, `variables.${name}`);
    }
    if (mode === "header") return value.replace(/[\r\n]+/g, " ");
    if (mode === "text") return value;
    return triple !== undefined && variable.raw ? value : escapeHtml(value);
  });
}

export interface TemplateSource {
  subject: string;
  html: string | null;
  text: string | null;
  variables: TemplateVariable[];
}

export interface RenderedTemplate {
  subject: string;
  html: string | null;
  text: string;
}

export function renderTemplate(template: TemplateSource, values: TemplateValues = {}): RenderedTemplate {
  const resolved = resolveValues(template.variables, values);
  const html = template.html == null ? null : renderString(template.html, template.variables, resolved, "html");
  const text = template.text != null ? renderString(template.text, template.variables, resolved, "text") : htmlToText(html ?? "");
  return { subject: renderString(template.subject, template.variables, resolved, "header"), html, text };
}

/** Rejects undeclared tags, duplicate names, `{{{x}}}` on a non-raw x, and bad fallbacks. */
function checkSource(input: { subject: string; html?: string | null; text?: string | null; variables: TemplateVariable[] }) {
  if (!input.html && !input.text) throw new MessageError(400, "bad_request", "html or text is required", "html");
  const declared = new Map<string, TemplateVariable>();
  for (const v of input.variables) {
    if (declared.has(v.name)) throw new MessageError(400, "bad_request", `${v.name} is declared twice`, "variables");
    if (v.fallback !== undefined) coerce(v, v.fallback);
    declared.set(v.name, v);
  }
  for (const [field, source] of [
    ["subject", input.subject],
    ["html", input.html ?? ""],
    ["text", input.text ?? ""],
  ] as const) {
    for (const m of source.matchAll(TAG_RE)) {
      const name = (m[1] ?? m[2])!;
      const v = declared.get(name);
      if (!v) throw new MessageError(422, "undeclared_variable", `${name} is used but not declared`, field);
      if (m[1] !== undefined && !v.raw) {
        throw new MessageError(422, "raw_not_declared", `{{{${name}}}} needs ${name} declared raw`, field);
      }
    }
  }
}

type TemplateRow = typeof templates.$inferSelect;

function publicTemplate(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    subject: row.subject,
    html: row.html,
    text: row.text,
    variables: row.variables as TemplateVariable[],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function asSource(row: TemplateRow): TemplateSource {
  return { subject: row.subject, html: row.html, text: row.text, variables: row.variables as TemplateVariable[] };
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data;
}

async function latestVersion(db: Db, domainId: string, name: string): Promise<number> {
  const [row] = await db
    .select({ v: max(templates.version) })
    .from(templates)
    .where(and(eq(templates.domainId, domainId), eq(templates.name, name)));
  return row?.v ?? 0;
}

async function insertVersion(db: Db, key: AuthenticatedKey, name: string, version: number, input: z.infer<typeof templateUpdateSchema>) {
  const id = crypto.randomUUID();
  try {
    await db.insert(templates).values({
      id,
      domainId: key.domainId!,
      name,
      version,
      subject: input.subject,
      html: input.html ?? null,
      text: input.text ?? null,
      variables: input.variables,
      createdBy: `key:${key.id}`,
    });
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("UNIQUE")) {
      throw new MessageError(409, "conflict", "The template changed at the same time; retry", "name");
    }
    throw err;
  }
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  return publicTemplate(row!);
}

export async function createTemplate(db: Db, key: AuthenticatedKey, raw: unknown) {
  const input = parse(templateSchema, raw);
  checkSource(input);
  if (await latestVersion(db, key.domainId!, input.name)) {
    throw new MessageError(409, "already_exists", "A template with this name exists; PUT a new version", "name");
  }
  return insertVersion(db, key, input.name, 1, input);
}

/** Saves a new version; earlier versions stay readable. */
export async function updateTemplate(db: Db, key: AuthenticatedKey, name: string, raw: unknown) {
  const input = parse(templateUpdateSchema, raw);
  checkSource(input);
  const current = await latestVersion(db, key.domainId!, name);
  if (!current) throw new MessageError(404, "not_found", "No such template");
  return insertVersion(db, key, name, current + 1, input);
}

/** The latest version, or `version` if given. Only ever the key's own domain. */
export async function findTemplate(db: Db, key: AuthenticatedKey, name: string, version?: number): Promise<TemplateRow> {
  const scope = and(eq(templates.domainId, key.domainId!), eq(templates.name, name));
  const [row] = await db
    .select()
    .from(templates)
    .where(version === undefined ? scope : and(scope, eq(templates.version, version)))
    .orderBy(desc(templates.version))
    .limit(1);
  if (!row) throw new MessageError(404, "not_found", "No such template");
  return row;
}

export async function getTemplate(db: Db, key: AuthenticatedKey, name: string, version?: number) {
  return publicTemplate(await findTemplate(db, key, name, version));
}

/** Latest version of each template, by name; `cursor` is the last name of the previous page. */
export async function listTemplates(db: Db, key: AuthenticatedKey, opts: { limit?: number; cursor?: string } = {}) {
  const limit = opts.limit ?? 50;
  const scope = eq(templates.domainId, key.domainId!);
  const rows = await db
    .select()
    .from(templates)
    .where(opts.cursor ? and(scope, gt(templates.name, opts.cursor)) : scope)
    .orderBy(asc(templates.name), desc(templates.version));
  const latest = new Map<string, TemplateRow>();
  for (const row of rows) if (!latest.has(row.name)) latest.set(row.name, row);
  const page = [...latest.values()].slice(0, limit);
  return { data: page.map(publicTemplate), nextCursor: latest.size > limit ? page.at(-1)!.name : null };
}

export async function listVersions(db: Db, key: AuthenticatedKey, name: string) {
  const rows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.domainId, key.domainId!), eq(templates.name, name)))
    .orderBy(desc(templates.version));
  if (!rows.length) throw new MessageError(404, "not_found", "No such template");
  return { data: rows.map(publicTemplate) };
}

export async function deleteTemplate(db: Db, key: AuthenticatedKey, name: string) {
  const deleted = await db
    .delete(templates)
    .where(and(eq(templates.domainId, key.domainId!), eq(templates.name, name)))
    .returning({ id: templates.id });
  if (!deleted.length) throw new MessageError(404, "not_found", "No such template");
  return { name, deleted: true, versions: deleted.length };
}

export const previewSchema = z
  .object({ version: z.number().int().min(1).optional(), variables: z.record(z.string(), z.unknown()).optional() })
  .strict();

export async function previewTemplate(db: Db, key: AuthenticatedKey, name: string, raw: unknown) {
  const input = parse(previewSchema, raw);
  const row = await findTemplate(db, key, name, input.version);
  return { name: row.name, version: row.version, ...renderTemplate(asSource(row), input.variables) };
}

export const sendTemplateSchema = z.union([
  z.string().min(1).max(64),
  z.object({ name: z.string().min(1).max(64), version: z.number().int().min(1).optional() }).strict(),
]);

/**
 * A send body naming `template` (+ `variables`) becomes a plain one: the
 * template's rendered subject, html and text. An explicit subject wins;
 * html or text alongside a template is an error. Bodies without `template`
 * pass through.
 */
export async function applyTemplate(
  db: Db,
  key: AuthenticatedKey,
  raw: unknown,
): Promise<{ body: unknown; templateId: string | null }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("template" in raw)) {
    return { body: raw, templateId: null };
  }
  const { template, variables, ...rest } = raw as Record<string, unknown>;
  const ref = sendTemplateSchema.safeParse(template);
  if (!ref.success) throw zodError(ref.error, "template");
  const values = z.record(z.string(), z.unknown()).optional().safeParse(variables);
  if (!values.success) throw zodError(values.error, "variables");
  if (rest.html !== undefined || rest.text !== undefined) {
    throw new MessageError(400, "bad_request", "Send html/text or a template, not both", "template");
  }
  const { name, version } = typeof ref.data === "string" ? { name: ref.data, version: undefined } : ref.data;
  const row = await findTemplate(db, key, name, version);
  const rendered = renderTemplate(asSource(row), values.data);
  return {
    body: {
      ...rest,
      subject: rest.subject ?? rendered.subject,
      ...(rendered.html != null ? { html: rendered.html } : {}),
      text: rendered.text,
    },
    templateId: row.id,
  };
}
