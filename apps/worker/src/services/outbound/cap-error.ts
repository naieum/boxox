/** Drizzle/D1 wrap SQLite errors. Inspect only the fixed trigger codes, never log SQL. */
export function sendCapViolation(error: unknown): "api_send_minute_cap" | "api_send_daily_cap" | "agent_send_hourly_cap" | "agent_send_daily_cap" | null {
  const codes = ["api_send_minute_cap", "api_send_daily_cap", "agent_send_hourly_cap", "agent_send_daily_cap"] as const;
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = codes.find((c) => current instanceof Error && current.message.includes(c));
    if (code) return code;
    current = current.cause;
  }
  return null;
}
