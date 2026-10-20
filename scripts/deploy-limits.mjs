/** Validate before provisioning. Raising throughput never changes a Cloudflare subscription. */
export function applyCapacitySettings(config, env = process.env) {
  const settings = [
    ['BOXOX_INBOUND_PER_MINUTE', 1, 100000, 'INBOUND_GLOBAL_RATE_LIMIT'],
    ['BOXOX_SENDER_PER_MINUTE', 1, 100000, 'INBOUND_RATE_LIMIT'],
    ['INGEST_MAX_CONCURRENCY', 1, 64],
    ['AGENT_SEND_LIMIT_PER_15_MIN', 1, 100000],
    ['SEARCH_BODY_CHAR_LIMIT', 0, 65536],
  ];
  for (const [name, min, max, limiter] of settings) {
    if (env[name] === undefined) continue;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]) || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    if (limiter) {
      const binding = config.ratelimits?.find(item => item.name === limiter);
      if (!binding) throw new Error(`Missing rate-limit binding ${limiter}`);
      binding.simple.limit = value;
    } else config.vars = { ...config.vars, [name]: String(value) };
  }
  if (env.INDEX_ATTACHMENT_TEXT !== undefined) {
    if (!['on', 'off'].includes(env.INDEX_ATTACHMENT_TEXT)) throw new Error('INDEX_ATTACHMENT_TEXT must be on or off');
    config.vars = { ...config.vars, INDEX_ATTACHMENT_TEXT: env.INDEX_ATTACHMENT_TEXT };
  }
  return config;
}
