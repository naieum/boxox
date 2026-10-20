import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

/**
 * `write` regenerates docs/api/openapi.json from the Worker's Zod routes and
 * src/schema.ts from that spec. `check` regenerates both in memory and fails
 * if either file is stale or a /dev/v1 route is missing from the spec.
 */
const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const SPEC = at("../../../docs/api/openapi.json");
const TYPES = at("../src/schema.ts");
const EXPORT = at("../../../apps/worker/src/dev/openapi-export.ts");

const mode = process.argv[2];
if (mode !== "write" && mode !== "check") {
  console.error("usage: openapi.mjs write|check");
  process.exit(2);
}

const out = execFileSync(process.execPath, ["--import", "tsx", EXPORT], { cwd: at(".."), encoding: "utf8" });
const { document, mounted, documented } = JSON.parse(out);

const problems = [];
const missing = mounted.filter((r) => !documented.includes(r));
const extra = documented.filter((r) => !mounted.includes(r));
if (missing.length) problems.push(`Routes not in the spec: ${missing.join(", ")}`);
if (extra.length) problems.push(`Spec routes with no handler: ${extra.join(", ")}`);

const specText = `${JSON.stringify(document, null, 2)}\n`;
const header = "// Generated from docs/api/openapi.json by `pnpm --filter @boxox/mail generate`. Do not edit.\n\n";
const typesText = header + astToString(await openapiTS(document, { alphabetize: true, defaultNonNullable: false }));

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

if (mode === "write") {
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  writeFileSync(SPEC, specText);
  writeFileSync(TYPES, typesText);
  console.log(`wrote ${SPEC} and ${TYPES}`);
} else {
  if (read(SPEC) !== specText) problems.push("docs/api/openapi.json is stale: run `pnpm --filter @boxox/mail generate`");
  if (read(TYPES) !== typesText) problems.push("packages/sdk/src/schema.ts does not match the spec: run `pnpm --filter @boxox/mail generate`");
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`openapi: ${documented.length} operations, spec and SDK types up to date`);
}
