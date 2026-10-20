#!/usr/bin/env node
/**
 * Offline capacity regression: real migrations and production service functions,
 * executed through Drizzle's D1 adapter backed by node:sqlite. This measures local
 * query/storage behavior, NOT Cloudflare throughput, billing, or account limits.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireWorker = createRequire(path.join(ROOT, 'apps/worker/package.json'));
const NOTICE = 'Local SQLite capacity regression, not Cloudflare throughput certification';

/** Load trusted local TS without changing source or importing Worker entrypoints.
 * Query construction and cursor codecs below are the actual production functions.
 * Only the route module's two policy primitives are extracted; loading Hono's
 * complete runtime would pull in Cloudflare-only outbound bindings unnecessarily.
 */
export function loadProductionServices() {
  const cache = new Map();
  const routePath = path.join(ROOT, 'apps/worker/src/routes/agent-api.ts');
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!filename.startsWith(path.join(ROOT, 'apps/worker/src/')) && !filename.startsWith(path.join(ROOT, 'packages/db/src/'))) throw new Error(`Unsupported benchmark module: ${filename}`);
    let source = readFileSync(filename, 'utf8');
    if (filename === routePath) {
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      source = ast.statements.filter(s => ['AgentError', 'hasPermission'].includes(s.name?.text)).map(s => s.getFullText(ast)).join('\n');
      assert.match(source, /class AgentError/);
      assert.match(source, /function hasPermission/);
    }
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} }; cache.set(filename, module);
    function localRequire(specifier) {
      if (specifier === '@boxox/db') return load(path.join(ROOT, 'packages/db/src/index.ts'));
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        return load(existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved);
      }
      if (!specifier.startsWith('drizzle-orm')) throw new Error(`Unexpected benchmark dependency: ${specifier}`);
      return requireWorker(specifier);
    }
    new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
    return module.exports;
  }
  return {
    reads: load(path.join(ROOT, 'apps/worker/src/services/agent-reads.ts')),
    work: load(path.join(ROOT, 'apps/worker/src/services/agent-work.ts')),
    database: load(path.join(ROOT, 'apps/worker/src/db.ts')),
  };
}

export function sqliteD1(sqlite, observations = new Map()) {
  const prepared = new Map();
  function statement(query, bindings = []) {
    let stmt = prepared.get(query);
    if (!stmt) { stmt = sqlite.prepare(query); prepared.set(query, stmt); }
    const observe = () => {
      const old = observations.get(query);
      if (old) old.calls++;
      else observations.set(query, { calls: 1, bindings });
    };
    return {
      bind: (...values) => statement(query, values),
      async all() { observe(); return { success: true, results: stmt.all(...bindings), meta: {} }; },
      async raw() { observe(); const names = stmt.columns().map(c => c.name); return stmt.all(...bindings).map(row => names.map(name => row[name])); },
      async run() { observe(); const result = stmt.run(...bindings); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      async first(name) { const row = (await this.all()).results[0] ?? null; return name ? row?.[name] ?? null : row; },
    };
  }
  return { prepare: query => statement(query), async batch(items) { sqlite.exec('BEGIN'); try { const results = []; for (const item of items) results.push(await item.all()); sqlite.exec('COMMIT'); return results; } catch (err) { sqlite.exec('ROLLBACK'); throw err; } } };
}

function measure(timings, name, operation) {
  const started = performance.now();
  return Promise.resolve(operation()).then(result => { timings[name] = Math.round((performance.now() - started) * 100) / 100; process.stderr.write(`capacity ${name}: ${timings[name]} ms\n`); return result; });
}
export async function runCapacityBenchmark({ messageCount = 100_000, outputPath = path.join(ROOT, '.loops/runs/agent-scale/capacity.json') } = {}) {
  assert.ok(Number.isInteger(messageCount) && messageCount >= 100 && messageCount <= 100_000, 'messageCount must be between100 and100000');
  const scratch = await mkdtemp(path.join(tmpdir(), 'boxox-agent-scale-'));
  const filename = path.join(scratch, 'capacity.sqlite');
  let sqlite;
  const started = performance.now();
  const timingsMs = {};
  try {
    sqlite = new DatabaseSync(filename);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;');
    const migrationFiles = (await readdir(path.join(ROOT, 'migrations'))).filter(f => /^\d.*\.sql$/.test(f)).sort();
    const sourceHashes = {};
    await measure(timingsMs, 'migrations', async () => {
      for (const name of migrationFiles) {
        const contents = await readFile(path.join(ROOT, 'migrations', name), 'utf8');
        sqlite.exec(contents); sourceHashes[`migrations/${name}`] = createHash('sha256').update(contents).digest('hex');
      }
    });
    const org = 'capacity-benchmark', address = 'capacity-mailbox', baseTime = Date.parse('2026-10-01T00:00:00Z');
    const hotCount = Math.min(1_000, Math.floor(messageCount / 10));
    const ordinaryThreads = Math.ceil((messageCount - hotCount) / 20);
    const threadCount = ordinaryThreads + 1;
    const expectedThreads = new Set(Array.from({ length: threadCount }, (_, i) => `thread-${String(i).padStart(6, '0')}`));
    const hotId = 'thread-000000';
    await measure(timingsMs, 'seed', async () => {
      sqlite.exec('BEGIN');
      sqlite.prepare('INSERT INTO domains(id,organization_id,name) VALUES(?,?,?)').run('capacity-domain', org, 'synthetic.example');
      sqlite.prepare('INSERT INTO addresses(id,domain_id,organization_id,local_part,created_by) VALUES(?,?,?,?,?)').run(address, 'capacity-domain', org, 'inbox', 'benchmark');
      const threadInsert = sqlite.prepare("INSERT INTO threads(id,organization_id,address_id,subject,subject_norm,snippet,last_message_at,message_count) VALUES(?,?,?,?,?,?,?,?)");
      for (let i = 0; i < threadCount; i++) threadInsert.run(`thread-${String(i).padStart(6, '0')}`, org, address, `Conversation ${i}`, `conversation ${i}`, 'Synthetic capacity fixture', baseTime + Math.floor(i / 10) * 1000, i === 0 ? hotCount : Math.min(20, messageCount - hotCount - (i - 1) * 20));
      const insert = sqlite.prepare("INSERT INTO messages(id,thread_id,organization_id,address_id,direction,from_email,to_emails,subject,snippet,search_text,r2_key,dedupe_scope,rfc_message_id,occurred_at,scan_status) VALUES(?,?,?,?,'inbound','sender@synthetic.example','[\"inbox@synthetic.example\"]',?,?,?,?,?,?,?,'scanned')");
      for (let i = 0; i < messageCount; i++) {
        const thread = i < hotCount ? hotId : `thread-${String(1 + Math.floor((i - hotCount) / 20)).padStart(6, '0')}`;
        insert.run(`message-${String(i).padStart(7, '0')}`, thread, org, address, `Invoice ${i}`, 'Synthetic invoice ready', i === messageCount - 2 ? 'uniquecapacityneedle invoice proof' : 'Synthetic invoice billing ready', `synthetic/${i}.json`, address, `<synthetic-${i}@synthetic.example>`, baseTime + Math.floor(i / 10) * 1000);
      }
      sqlite.exec('COMMIT; ANALYZE;');
    });
    const observations = new Map();
    const { reads, work, database } = loadProductionServices();
    for (const file of ['apps/worker/src/services/agent-reads.ts', 'apps/worker/src/services/agent-work.ts', 'apps/worker/src/services/agent-policy.ts', 'apps/worker/src/db.ts']) sourceHashes[file] = createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex');
    const db = database.createDb({ DB: sqliteD1(sqlite, observations) });
    const principal = { id: 'capacity-agent', organizationId: org };
    const grants = [{ addressId: address, permissions: ['read'] }];
    let r2Reads = 0;
    const bindings = { MAIL_STORE: { get: async () => { r2Reads++; throw new Error('Metadata benchmark must never fetch R2'); } } };
    let threadPages = 0;
    await measure(timingsMs, 'paginateThreads', async () => {
      const seen = new Set(); let cursor;
      do {
        const page = await reads.listAgentThreads(db, principal, grants, address, { limit: 100, cursor });
        assert.ok(page.threads.length <= 100);
        for (const thread of page.threads) { assert.ok(!seen.has(thread.id), 'Duplicate thread across cursor pages'); seen.add(thread.id); }
        if (page.nextCursor) assert.notEqual(page.nextCursor, cursor, 'Thread cursor did not advance');
        threadPages++; cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen, expectedThreads);
    });
    let messagePages = 0;
    await measure(timingsMs, 'paginateLongThread', async () => {
      const seen = new Set(); let cursor;
      do {
        const page = await reads.getAgentThread(bindings, db, principal, grants, hotId, { limit: 100, cursor });
        for (const message of page.messages) { assert.ok(!seen.has(message.id)); assert.equal(message.text, null); seen.add(message.id); }
        if (page.nextCursor) assert.notEqual(page.nextCursor, cursor, 'Message cursor did not advance');
        messagePages++; cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.size, hotCount); assert.equal(r2Reads, 0);
    });
    let workPages = 0;
    await measure(timingsMs, 'paginateAllPendingWork', async () => {
      const seen = new Set(); let cursor;
      do {
        const page = await work.listAgentWork(db, principal, grants, address, { limit: 100, cursor });
        for (const message of page.messages) { assert.ok(!seen.has(message.messageId), 'Duplicate message across work pages'); seen.add(message.messageId); }
        if (page.nextCursor) assert.notEqual(page.nextCursor, cursor, 'Work cursor did not advance');
        workPages++; cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.size, messageCount, 'Work pagination must cover every synthetic message');
    });
    const expectedEvents = Number(sqlite.prepare('SELECT count(*) AS n FROM agent_changes WHERE organization_id=? AND address_id=?').get(org, address).n);
    let feedPages = 0, checkpoint;
    await measure(timingsMs, 'paginateChanges', async () => {
      const first = await reads.listAgentChanges(db, principal, grants, address, { limit: 100 });
      const replay = await reads.listAgentChanges(db, principal, grants, address, { limit: 100 });
      assert.deepEqual(replay, first, 'Replayed page and checkpoint must agree');
      let page = first, count = 0, previousSeq = 0;
      do {
        for (const change of page.changes) {
          const decoded = JSON.parse(atob(change.cursor.replace(/-/g, '+').replace(/_/g, '/')));
          assert.ok(decoded.seq > previousSeq, 'Change cursor must increase even for tied timestamps'); previousSeq = decoded.seq; count++;
        }
        feedPages++; checkpoint = page.nextCursor;
        if (!page.hasMore) break;
        assert.ok(page.changes.length > 0, 'Nonterminal feed page must advance');
        page = await reads.listAgentChanges(db, principal, grants, address, { limit: 100, cursor: checkpoint });
      } while (true);
      assert.equal(count, expectedEvents);
      const idle = await reads.listAgentChanges(db, principal, grants, address, { cursor: checkpoint });
      assert.deepEqual(idle.changes, []); assert.equal(idle.nextCursor, checkpoint);
    });
    await measure(timingsMs, 'keywordSearch', async () => {
      const hits = await database.searchThreads(db, { query: 'uniquecapacityneedle', addressIds: [address], orgId: org });
      const expected = sqlite.prepare('SELECT thread_id FROM messages WHERE id=?').get(`message-${String(messageCount - 2).padStart(7, '0')}`).thread_id;
      assert.deepEqual(hits.map(hit => hit.threadId), [expected]);
    });
    await measure(timingsMs, 'claimCompleteReplay', async () => {
      const messageId = 'message-0000000';
      const receipt = await work.claimAgentWork(db, principal, grants, { messageId });
      await assert.rejects(work.claimAgentWork(db, principal, grants, { messageId }), e => e.code === 'work_unavailable');
      const acknowledgment = { messageId, claimToken: receipt.claimToken };
      await work.completeAgentWork(db, principal, grants, acknowledgment);
      await work.completeAgentWork(db, principal, grants, acknowledgment);
      const first = await work.listAgentWork(db, principal, grants, address, { limit: 100 });
      assert.ok(first.messages.every(m => m.messageId !== messageId));
    });
    const findPlan = (predicate, index, alternative) => {
      const match = [...observations].find(([query]) => predicate(query));
      assert.ok(match, `Production query not exercised for ${index}`);
      const [query, observation] = match;
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...observation.bindings).map(row => row.detail);
      assert.ok(plan.some(line => line.includes(index) || alternative?.test(line)), `Expected ${index}, got ${plan.join('; ')}`);
      return { query, plan };
    };
    const queryPlans = {
      threads: findPlan(q => q.includes('from "threads"') && q.includes('order by "threads"."last_message_at"'), 'threads_agent_page_idx'),
      messages: findPlan(q => q.includes('from "messages"') && q.includes('order by "messages"."occurred_at"') && !q.includes('inner join'), 'messages_agent_page_idx'),
      work: findPlan(q => q.includes('agent_work w') && q.includes('order by'), 'messages_agent_work_page'),
      // With a single large mailbox, SQLite may choose the primary-key sequence
      // range instead. Both plans seek bounded sequence values without a scan.
      changes: findPlan(q => q.includes('FROM agent_changes c'), 'agent_changes_mailbox_seq_idx', /SEARCH c USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/),
      changeWatermark: findPlan(q => q.includes('SELECT coalesce(max(seq)') && q.includes('FROM agent_changes'), 'agent_changes_mailbox_seq_idx'),
      keywordSearch: findPlan(q => q.includes('WITH hits AS MATERIALIZED'), 'VIRTUAL TABLE INDEX'),
    };
    const sizeBytes = (await stat(filename)).size;
    const report = { passed: true, notice: NOTICE, runtime: process.version, sqliteVersion: sqlite.prepare('select sqlite_version() AS version').get().version, generatedAt: new Date().toISOString(), fixture: { messages: messageCount, threads: threadCount, longThreadMessages: hotCount, journalEvents: expectedEvents, timestampTieGroup: 10, indexedText: 'Short synthetic text; databaseBytes is not a forecast for full real-world mailbox storage', r2BodiesStored: 0, attachmentsStored: 0 }, verified: { completeThreadCoverage: true, completeWorkMessageCoverage: true, completeChangeCoverage: true, cursorReplay: true, keywordSearch: true, claimCompletionReplay: true, metadataR2Reads: r2Reads }, pageCounts: { threads: threadPages, longThread: messagePages, pendingWork: workPages, changes: feedPages }, databaseBytes: sizeBytes, timingsMs: { ...timingsMs, total: Math.round((performance.now() - started) * 100) / 100 }, sqliteSettings: { journalMode: 'memory', synchronous: 'off', durabilityTested: false }, queryPlans, sourceHashes };
    if (outputPath) { await mkdir(path.dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`); }
    return report;
  } finally { try { sqlite?.close(); } finally { await rm(scratch, { recursive: true, force: true }); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report = await runCapacityBenchmark(); process.stdout.write(`${JSON.stringify({ passed: report.passed, notice: report.notice, messages: report.fixture.messages, databaseBytes: report.databaseBytes, timingsMs: report.timingsMs })}\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
