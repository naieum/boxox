import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCapacityBenchmark } from '../benchmark-agent-scale.mjs';

test('offline capacity verifier executes real service cursors, FTS, claims, and indexes', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'boxox-capacity-report-test-'));
  try {
    const filename = path.join(output, 'capacity.json');
    const report = await runCapacityBenchmark({ messageCount: 2_000, outputPath: filename });
    assert.equal(report.passed, true);
    assert.equal(report.fixture.messages, 2_000);
    assert.equal(report.fixture.journalEvents, report.fixture.messages + report.fixture.threads);
    assert.equal(report.verified.completeWorkMessageCoverage, true);
    assert.equal(report.verified.metadataR2Reads, 0);
    assert.ok(report.pageCounts.pendingWork > 1);
    assert.match(report.notice, /not Cloudflare throughput certification/);
    assert.equal(report.sqliteSettings.durabilityTested, false);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), report);
    assert.deepEqual(await readdir(output), ['capacity.json'], 'No database or mail fixtures should remain in report directory');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('capacity fixture bounds reject accidental oversized runs before creating files', async () => {
  for (const messageCount of [0, 99, 100_001, NaN, 1.5]) {
    await assert.rejects(runCapacityBenchmark({ messageCount, outputPath: null }), /messageCount/);
  }
});
