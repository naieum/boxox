#!/usr/bin/env node
/**
 * Live-only when invoked as the entrypoint. Development tests import runLiveChecks
 * with fixture clients; they never load the ignored credential file.
 *
 * Build SDK first: pnpm --filter @boxox/mail build
 * Required .loops/secrets/e2e.env fields (never commit or echo values):
 * BOXOX_URL, BOXOX_KEY, BOXOX_E2E_OTHER_KEY,
 * BOXOX_E2E_CAPTURE_URL, BOXOX_E2E_CAPTURE_TOKEN.
 * --other-env PATH may instead supply the other domain's BOXOX_KEY.
 *
 * The capture Worker is deliberately separate from Box Ox. An operator can deploy
 * scripts/e2e-capture.wrangler.jsonc with a UNIQUE --name, install its
 * E2E_CAPTURE_TOKEN secret, run this script, then delete that temporary Worker.
 * This script does not deploy anything. It removes its webhook/session in finally.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { BoxOx, BoxOxError, verifyWebhook } from '../packages/sdk/dist/index.js';

class AssertionFailure extends Error {}

export class CheckFailure extends Error {
  constructor(step, reason) { super(reason); this.name = 'CheckFailure'; this.step = step; }
}
const check = (condition, message) => { if (!condition) throw new AssertionFailure(message); };

export function parseEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new CheckFailure('configuration', 'Invalid environment-file line; use NAME=value without shell expressions');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    result[match[1]] = value;
  }
  return result;
}
function origin(raw, name) {
  let url; try { url = new URL(raw); } catch { throw new CheckFailure('configuration', `${name} must be an HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new CheckFailure('configuration', `${name} must be an HTTPS origin`);
  return url.origin;
}
function number(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new CheckFailure('configuration', `${name} is outside the supported bounds`);
  return result;
}
export function configuration(values, otherValues = {}) {
  for (const name of ['BOXOX_URL', 'BOXOX_KEY', 'BOXOX_E2E_CAPTURE_URL', 'BOXOX_E2E_CAPTURE_TOKEN']) if (!values[name]) throw new CheckFailure('configuration', `Missing ${name}`);
  const otherKey = values.BOXOX_E2E_OTHER_KEY ?? otherValues.BOXOX_KEY;
  if (!otherKey) throw new CheckFailure('configuration', 'Provide BOXOX_E2E_OTHER_KEY or --other-env with a send-capable key for another domain');
  if (!/^bxk_[A-Za-z0-9_-]+$/.test(values.BOXOX_KEY) || !/^bxk_[A-Za-z0-9_-]+$/.test(otherKey)) throw new CheckFailure('configuration', 'Both API credentials must be bxk_ domain keys');
  if (otherKey === values.BOXOX_KEY) throw new CheckFailure('configuration', 'The cross-domain credential must differ from the primary credential');
  if (otherValues.BOXOX_URL && origin(otherValues.BOXOX_URL, 'other BOXOX_URL') !== origin(values.BOXOX_URL, 'BOXOX_URL')) throw new CheckFailure('configuration', 'Both domain keys must belong to the same Box Ox installation');
  const from = values.BOXOX_E2E_FROM ?? 'e2e@boxox.dev';
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@boxox\.dev$/.test(from)) throw new CheckFailure('configuration', 'BOXOX_E2E_FROM must be an address on boxox.dev');
  const captureToken = values.BOXOX_E2E_CAPTURE_TOKEN;
  if (captureToken.length < 32 || /[\r\n]/.test(captureToken)) throw new CheckFailure('configuration', 'BOXOX_E2E_CAPTURE_TOKEN must be at least 32 characters');
  return {
    url: origin(values.BOXOX_URL, 'BOXOX_URL'), key: values.BOXOX_KEY, otherKey, from,
    captureUrl: origin(values.BOXOX_E2E_CAPTURE_URL, 'BOXOX_E2E_CAPTURE_URL'), captureToken,
    pollTimeoutMs: number(values.BOXOX_E2E_TIMEOUT_MS, 600_000, 1000, 1_800_000, 'BOXOX_E2E_TIMEOUT_MS'),
    totalTimeoutMs: number(values.BOXOX_E2E_TOTAL_TIMEOUT_MS, 2_700_000, 1000, 6_000_000, 'BOXOX_E2E_TOTAL_TIMEOUT_MS'),
    intervalMs: number(values.BOXOX_E2E_INTERVAL_MS, 2500, 250, 15_000, 'BOXOX_E2E_INTERVAL_MS'),
    requestTimeoutMs: number(values.BOXOX_E2E_REQUEST_TIMEOUT_MS, 15_000, 1000, 60_000, 'BOXOX_E2E_REQUEST_TIMEOUT_MS'),
  };
}
function summary(error) {
  if (error instanceof BoxOxError) return `HTTP ${error.status} (${error.code})`;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error.name;
  return 'request failed'; // Never expose SDK response text, URLs, headers or credentials.
}
async function expectedError(action, status, code) {
  try { await action(); } catch (error) {
    if (error instanceof BoxOxError && error.status === status && error.code === code) return;
    throw new AssertionFailure(`Expected HTTP ${status} (${code}); got ${summary(error)}`);
  }
  throw new AssertionFailure(`Expected HTTP ${status} (${code}); request unexpectedly succeeded`);
}

export function captureClient(config, signal, transport = fetch) {
  async function request(method, session) {
    const signals = [AbortSignal.timeout(config.requestTimeoutMs), ...(signal ? [signal] : [])];
    const response = await transport(`${config.captureUrl}/sessions/${session}`, {
      method, headers: { authorization: `Bearer ${config.captureToken}` }, signal: AbortSignal.any(signals), redirect: 'error',
    });
    if (!response.ok) throw new AssertionFailure(`Capture endpoint rejected ${method} with HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  return { create: (id) => request('PUT', id), events: (id) => request('GET', id), delete: (id) => request('DELETE', id), hookUrl: (id) => `${config.captureUrl}/hook/${id}` };
}

/** Every Box Ox request is made through the SDK, including its per-call timeout. */
function client(config, key, signal) {
  return new BoxOx({ key, url: config.url, fetch: (input, init = {}) => fetch(input, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]), redirect: 'error',
  }) });
}

export async function runLiveChecks(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? pause, log = dependencies.log ?? console.log;
  const nonce = dependencies.nonce ?? randomBytes(16).toString('hex');
  check(/^[a-f0-9]{32}$/.test(nonce), 'Test nonce must be 32 hexadecimal characters');
  const mail = dependencies.mail ?? client(config, config.key, dependencies.signal);
  const other = dependencies.other ?? client(config, config.otherKey, dependencies.signal);
  const capture = dependencies.capture ?? captureClient(config, dependencies.signal);
  const cleanupMail = dependencies.cleanupMail ?? mail, cleanupCapture = dependencies.cleanupCapture ?? capture;
  const verify = dependencies.verify ?? verifyWebhook;
  const deadline = now() + config.totalTimeoutMs;
  const to = `e2e+${nonce}@boxox.dev`, baseInbox = 'e2e@boxox.dev';
  const bounceTo = `boxoxe2e${nonce.slice(0, 20)}@gmail.com`;
  const subject = `Box Ox live E2E ${nonce}`, marker = `boxox-e2e:${nonce}`;
  let hook, sessionCreated = false, failure;
  const report = { nonce };
  async function step(name, action) {
    if (now() >= deadline || dependencies.signal?.aborted) throw new CheckFailure(name, 'Overall E2E deadline reached or execution interrupted');
    try { const result = await action(); log(`PASS ${name}`); return result; }
    catch (error) { throw error instanceof CheckFailure ? error : new CheckFailure(name, error instanceof AssertionFailure ? error.message : error instanceof BoxOxError ? summary(error) : error.message === 'No signature matched' ? 'Webhook signature did not match' : 'Check failed; inspect the corresponding API timeline or temporary capture session'); }
  }
  async function poll(name, probe) {
    const until = Math.min(deadline, now() + config.pollTimeoutMs);
    let transient;
    while (now() < until && !dependencies.signal?.aborted) {
      try { const found = await probe(); if (found !== undefined && found !== null && found !== false) return found; }
      catch (error) {
        if ((error instanceof BoxOxError && (error.status === 429 || error.status >= 500)) || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name)) transient = summary(error);
        else throw error;
      }
      await sleep(Math.min(config.intervalMs, Math.max(1, until - now())));
    }
    throw new CheckFailure(name, `Timed out waiting for required evidence${transient ? `; last transient: ${transient}` : ''}`);
  }
  async function received() {
    // The receiving API filters the routed app inbox, not the plus alias. Match
    // the original To header and this run's subject before checking the body.
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await mail.received.list({ to: baseInbox, limit: 100, cursor });
      const item = result.data.find((item) => item.subject === subject && item.toEmails.some((email) => email.toLowerCase() === to));
      if (item) return item;
      if (!result.nextCursor) return undefined;
      cursor = result.nextCursor;
    }
  }
  try {
    await step('preflight-primary', async () => {
      await mail.messages.list({ limit: 1 }); await mail.received.list({ to: baseInbox, limit: 1 });
      await mail.webhooks.list(); await mail.suppressions.list({ limit: 1 });
    });
    await step('cross-domain-refused', () => expectedError(() => other.messages.send({ from: config.from, to, subject, text: marker }), 403, 'from_not_allowed'));
    await step('capture-session', async () => { await capture.create(nonce); sessionCreated = true; });
    await step('register-temporary-webhook', async () => {
      hook = await mail.webhooks.create({ url: capture.hookUrl(nonce), events: ['message.delivered', 'message.bounced', 'message.failed'] });
      check(hook.id && hook.secret, 'The webhook create reply must include id and signing secret');
    });
    const message = { from: config.from, to, subject, text: `Synthetic Box Ox delivery check. ${marker}`, tags: { e2e: nonce } };
    const sent = await step('send-round-trip', async () => {
      const result = await mail.messages.send(message, { idempotencyKey: `e2e:${nonce}:roundtrip` });
      check(result.id && result.status !== 'failed', 'Round-trip message was not queued'); return result;
    });
    report.messageId = sent.id;
    await step('idempotency-replay', async () => {
      const replay = await mail.messages.send(message, { idempotencyKey: `e2e:${nonce}:roundtrip` });
      check(replay.id === sent.id, 'Identical idempotency replay created another message');
    });
    await step('idempotency-conflict', () => expectedError(() => mail.messages.send({ ...message, subject: `${subject} conflict` }, { idempotencyKey: `e2e:${nonce}:roundtrip` }), 409, 'idempotency_key_reused'));
    const inbound = await step('received-round-trip', () => poll('received-round-trip', received));
    report.receivedId = inbound.id;
    await step('received-body', async () => { const detail = await mail.received.get(inbound.id); check(detail.text?.includes(marker), 'The received body does not contain this run marker'); });
    await step('delivered-timeline', () => poll('delivered-timeline', async () => {
      const detail = await mail.messages.get(sent.id);
      if (['failed', 'bounced', 'complained', 'canceled'].includes(detail.status)) throw new CheckFailure('delivered-timeline', `Round trip reached terminal ${detail.status} before delivery`);
      return detail.timeline.find((event) => event.type === 'delivered' && event.recipient?.toLowerCase() === to);
    }));
    await step('signed-webhook', () => poll('signed-webhook', async () => {
      const result = await capture.events(nonce);
      for (const captured of result.events) {
        const receivedAt = Date.parse(captured.receivedAt);
        check(Number.isFinite(receivedAt) && receivedAt <= now() + 60_000, 'Capture reply has an invalid receipt timestamp');
        // Verify freshness when the endpoint received the HTTP request. Polling
        // after a slow inbound round trip must not turn a valid captured
        // signature into a stale replay; the endpoint's capture is authenticated.
        const event = await verify(captured.body, captured.headers, hook.secret, { now: receivedAt });
        if (event.type === 'message.delivered' && (event.data.messageId ?? event.data.id) === sent.id) return true;
      }
    }));
    const bounced = await step('send-nonexistent-gmail', async () => {
      const result = await mail.messages.send({ from: config.from, to: bounceTo, subject: `Box Ox bounce check ${nonce}`, text: `Synthetic nonexistent mailbox check. ${marker}`, tags: { e2e: nonce } }, { idempotencyKey: `e2e:${nonce}:bounce` });
      check(result.id && result.status !== 'failed', 'Bounce probe was not queued'); return result;
    });
    report.bounceMessageId = bounced.id;
    await step('bounced-timeline', () => poll('bounced-timeline', async () => {
      const detail = await mail.messages.get(bounced.id);
      if (detail.status === 'delivered') throw new CheckFailure('bounced-timeline', 'The generated Gmail mailbox unexpectedly accepted delivery');
      return detail.timeline.find((event) => event.type === 'bounced' && event.recipient?.toLowerCase() === bounceTo);
    }));
    await step('bounce-suppression', () => poll('bounce-suppression', async () => {
      try { const suppression = await mail.suppressions.get(bounceTo); return suppression.email?.toLowerCase() === bounceTo && suppression.reason === 'bounce'; }
      catch (error) { if (error instanceof BoxOxError && error.status === 404) return undefined; throw error; }
    }));
  } catch (error) { failure = error; }
  finally {
    const cleanupFailures = [];
    if (hook?.id) { try { await cleanupMail.webhooks.delete(hook.id); log('PASS cleanup-webhook'); } catch { cleanupFailures.push('temporary Box Ox webhook'); } }
    if (sessionCreated) { try { await cleanupCapture.delete(nonce); log('PASS cleanup-capture'); } catch { cleanupFailures.push('temporary capture session'); } }
    if (cleanupFailures.length) { log(`FAIL cleanup: could not delete ${cleanupFailures.join(' and ')}; operator cleanup required`); failure ??= new CheckFailure('cleanup', 'Temporary resource cleanup failed'); }
  }
  if (failure) throw failure;
  log(`PASS live-e2e ${JSON.stringify(report)}`);
  return report;
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/e2e-live.mjs [--env FILE] [--other-env FILE]\nDefaults to .loops/secrets/e2e.env. Build @boxox/mail first.\nRequired: BOXOX_URL, BOXOX_KEY, BOXOX_E2E_OTHER_KEY (or --other-env), BOXOX_E2E_CAPTURE_URL, BOXOX_E2E_CAPTURE_TOKEN.\nA real other-domain key must hold send. The primary key needs send/read_log/read_received/webhooks.\nDeploy the disposable helper separately with scripts/e2e-capture.wrangler.jsonc and a unique --name; install E2E_CAPTURE_TOKEN. Delete that Worker after the run.\nThis command sends two synthetic live emails when fully configured. No checks are skipped.'); return;
  }
  let envFile = resolve('.loops/secrets/e2e.env'), otherFile;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    if (!['--env', '--other-env'].includes(flag) || !value || value.startsWith('--')) throw new CheckFailure('configuration', 'Use --env FILE and optionally --other-env FILE');
    if (flag === '--env') envFile = resolve(value); else otherFile = resolve(value);
  }
  let values, otherValues = {};
  try { values = parseEnv(await readFile(envFile, 'utf8')); if (otherFile) otherValues = parseEnv(await readFile(otherFile, 'utf8')); }
  catch (error) { throw error instanceof CheckFailure ? error : new CheckFailure('configuration', 'Cannot read the requested ignored E2E environment file'); }
  const config = configuration(values, otherValues), controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const cleanupMail = client(config, config.key), cleanupCapture = captureClient(config);
  await runLiveChecks(config, { signal: controller.signal, cleanupMail, cleanupCapture });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`FAIL ${error instanceof CheckFailure ? error.step : 'startup'}: ${error instanceof CheckFailure ? error.message : summary(error)}`); process.exitCode = 1; }
}
