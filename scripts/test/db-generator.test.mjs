import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dbDir = join(root, "packages/db");
const dbRequire = createRequire(join(dbDir, "package.json"));
const kitBin = join(dirname(dbRequire.resolve("drizzle-kit")), "bin.cjs");

test("sent-folder migration preserves received conversations, user filing, and message data", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, folder TEXT, unread INTEGER); CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT, direction TEXT, body_key TEXT)");
    for (const [id, folder, directions] of [
      ["outgoing", "inbox", ["outbound"]], ["mixed", "inbox", ["outbound", "inbound"]],
      ["incoming", "inbox", ["inbound"]], ["empty", "inbox", []],
      ["archived", "archive", ["outbound"]], ["trashed", "trash", ["outbound"]],
    ]) {
      db.prepare("INSERT INTO threads VALUES (?, ?, 1)").run(id, folder);
      directions.forEach((direction, i) => db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(`${id}-${i}`, id, direction, `body/${id}-${i}`));
    }
    const before = db.prepare("SELECT * FROM messages ORDER BY id").all();
    const migration = await readFile(join(root, "migrations/0004_sent_folder.sql"), "utf8");
    db.exec(migration); db.exec(migration);
    assert.deepEqual(db.prepare("SELECT id, folder FROM threads ORDER BY id").all().map(row => ({ ...row })), [
      { id: "archived", folder: "archive" }, { id: "empty", folder: "inbox" }, { id: "incoming", folder: "inbox" },
      { id: "mixed", folder: "inbox" }, { id: "outgoing", folder: "sent" }, { id: "trashed", folder: "trash" },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM messages ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT unread FROM threads WHERE id = 'outgoing'").get().unread, 1);
  } finally { db.close(); }
});

test("deprecated loader's patched esbuild still transforms TypeScript", async () => {
  const kitRequire = createRequire(kitBin);
  const loaderRequire = createRequire(kitRequire.resolve("@esbuild-kit/esm-loader"));
  const { transform, transformSync } = loaderRequire("@esbuild-kit/core-utils");
  const source = "const value: number = 42; module.exports = value;";
  const sync = transformSync(source, "/tmp/boxox-probe.cts");
  const module = { exports: {} };
  runInNewContext(sync.code, { module, exports: module.exports });
  assert.equal(module.exports, 42);
  assert.ok(sync.map, "CommonJS transform still returns a source map");
  const esm = await transform("export const value: number = 42;", "/tmp/boxox-probe.mts");
  const imported = await import(`data:text/javascript;base64,${Buffer.from(esm.code).toString("base64")}`);
  assert.equal(imported.value, 42);
  assert.ok(esm.map, "ESM transform still returns a source map");
});

test("real schema generation and incremental migrations preserve data", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxox-db-generator-"));
  const database = new DatabaseSync(":memory:");
  try {
    // Every generator input/output lives in this disposable directory.
    await cp(join(dbDir, "src/schema"), join(directory, "schema"), { recursive: true });
    await cp(join(root, "migrations"), join(directory, "migrations"), { recursive: true });
    await symlink(join(dbDir, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "drizzle.config.ts"), 'export default { schema: "./schema/index.ts", out: "./migrations", dialect: "sqlite" };\n');

    const sqlFiles = async () => (await readdir(join(directory, "migrations")))
      .filter((file) => file.endsWith(".sql")).sort();
    const generate = (name) => execFileSync(process.execPath,
      [kitBin, "generate", "--config", "drizzle.config.ts", "--name", name],
      { cwd: directory, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const initialFiles = await sqlFiles();
    assert.match(generate("unchanged"), /No schema changes/);
    assert.deepEqual(await sqlFiles(), initialFiles);
    for (const file of initialFiles) {
      database.exec(await readFile(join(directory, "migrations", file), "utf8"));
    }

    const index = join(directory, "schema/index.ts");
    const original = await readFile(index, "utf8");
    const fixture = (extra = "") => `${original}\nimport { sqliteTable, text } from "drizzle-orm/sqlite-core";\nexport const migrationProbe = sqliteTable("migration_probe", { id: text("id").primaryKey(), payload: text("payload").notNull()${extra} });\n`;
    await writeFile(index, fixture());
    generate("schema_generator_probe");
    const afterCreate = await sqlFiles();
    assert.equal(afterCreate.length, initialFiles.length + 1, "generate must produce SQL, even if CLI incorrectly returns success after an error");
    const createSql = await readFile(join(directory, "migrations", afterCreate.at(-1)), "utf8");
    assert.match(createSql, /CREATE TABLE `migration_probe`/);
    database.exec(createSql);
    database.prepare("INSERT INTO migration_probe (id, payload) VALUES (?, ?)").run("keep", "retained");

    await writeFile(index, fixture(', note: text("note")'));
    generate("schema_generator_increment");
    const afterAlter = await sqlFiles();
    assert.equal(afterAlter.length, afterCreate.length + 1);
    const alterSql = await readFile(join(directory, "migrations", afterAlter.at(-1)), "utf8");
    assert.match(alterSql, /ALTER TABLE `migration_probe` ADD `note` text/);
    database.exec(alterSql);
    assert.deepEqual({ ...database.prepare("SELECT * FROM migration_probe").get() },
      { id: "keep", payload: "retained", note: null });
    assert.match(generate("unchanged_again"), /No schema changes/);
    assert.deepEqual(await sqlFiles(), afterAlter);
    console.log(`Generated SQL SHA256: ${createHash("sha256").update(createSql).update(alterSql).digest("hex")}`);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
