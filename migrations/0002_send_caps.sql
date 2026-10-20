-- Check at the write boundary: count-then-await checks alone race across requests.
-- D1 serializes writes, and an ABORT rolls back the whole message/event batch.
CREATE INDEX api_messages_key_created_idx ON api_messages(api_key_id, created_at);
CREATE INDEX audit_events_actor_action_created_idx ON audit_events(actor_type, actor_id, action, created_at);

CREATE TRIGGER api_messages_send_caps BEFORE INSERT ON api_messages
WHEN NEW.api_key_id IS NOT NULL
BEGIN
  SELECT CASE WHEN (
    SELECT rate_limit_per_minute FROM api_keys WHERE id = NEW.api_key_id
  ) IS NOT NULL AND (
    SELECT count(*) FROM api_messages WHERE api_key_id = NEW.api_key_id
      AND created_at >= cast(unixepoch('subsec') * 1000 as integer) - 60000
  ) >= (SELECT rate_limit_per_minute FROM api_keys WHERE id = NEW.api_key_id)
  THEN RAISE(ABORT, 'api_send_minute_cap') END;
  SELECT CASE WHEN (
    SELECT daily_send_cap FROM api_keys WHERE id = NEW.api_key_id
  ) IS NOT NULL AND (
    SELECT count(*) FROM api_messages WHERE api_key_id = NEW.api_key_id
      AND created_at >= cast(unixepoch('subsec') * 1000 as integer) - 86400000
  ) >= (SELECT daily_send_cap FROM api_keys WHERE id = NEW.api_key_id)
  THEN RAISE(ABORT, 'api_send_daily_cap') END;
END;

-- agent.message_sent is reserved atomically with the queued message BEFORE I/O.
-- Defaults match DEFAULT_SEND_CAPS in services/agent-policy.ts.
CREATE TRIGGER agent_audit_send_caps BEFORE INSERT ON audit_events
WHEN NEW.actor_type = 'agent' AND NEW.action = 'agent.message_sent'
  AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.actor_id)
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM audit_events WHERE actor_type = 'agent' AND actor_id = NEW.actor_id
      AND action = 'agent.message_sent' AND created_at > cast(unixepoch('subsec') * 1000 as integer) - 3600000
  ) >= (SELECT coalesce(send_hourly_cap, 20) FROM agents WHERE id = NEW.actor_id)
  THEN RAISE(ABORT, 'agent_send_hourly_cap') END;
  SELECT CASE WHEN (
    SELECT count(*) FROM audit_events WHERE actor_type = 'agent' AND actor_id = NEW.actor_id
      AND action = 'agent.message_sent' AND created_at > cast(unixepoch('subsec') * 1000 as integer) - 86400000
  ) >= (SELECT coalesce(send_daily_cap, 100) FROM agents WHERE id = NEW.actor_id)
  THEN RAISE(ABORT, 'agent_send_daily_cap') END;
END;
