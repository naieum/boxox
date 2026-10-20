import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCapacitySettings } from '../deploy-limits.mjs';
const config = () => ({ ratelimits: [{ name: 'INBOUND_GLOBAL_RATE_LIMIT', simple: { limit: 300, period: 60 } }, { name: 'INBOUND_RATE_LIMIT', simple: { limit: 60, period: 60 } }] });
test('capacity defaults do not raise throttles and owner settings apply only to intended bindings', () => {
  assert.deepEqual(applyCapacitySettings(config(), {}), config());
  const updated = applyCapacitySettings(config(), { BOXOX_INBOUND_PER_MINUTE: '3000', BOXOX_SENDER_PER_MINUTE: '120', INGEST_MAX_CONCURRENCY: '12', SEARCH_BODY_CHAR_LIMIT: '0', INDEX_ATTACHMENT_TEXT: 'off', AGENT_SEND_LIMIT_PER_15_MIN: '1000' });
  assert.deepEqual(updated.ratelimits.map(item => item.simple), [{ limit: 3000, period: 60 }, { limit: 120, period: 60 }]);
  assert.deepEqual(updated.vars, { INGEST_MAX_CONCURRENCY: '12', SEARCH_BODY_CHAR_LIMIT: '0', INDEX_ATTACHMENT_TEXT: 'off', AGENT_SEND_LIMIT_PER_15_MIN: '1000' });
});
test('invalid settings fail before any provisioning', () => {
  for (const [name, value] of [['BOXOX_INBOUND_PER_MINUTE', '0'], ['INGEST_MAX_CONCURRENCY', '65'], ['SEARCH_BODY_CHAR_LIMIT', '-1'], ['AGENT_SEND_LIMIT_PER_15_MIN', 'NaN'], ['INDEX_ATTACHMENT_TEXT', 'yes']]) assert.throws(() => applyCapacitySettings(config(), { [name]: value }), new RegExp(name));
});
