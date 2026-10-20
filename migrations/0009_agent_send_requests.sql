-- A retry key never becomes permission to send. Live grants are checked first.
CREATE TABLE agent_send_requests (
  organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, agent_id, request_key)
);
CREATE INDEX messages_sender_probe_idx ON messages(organization_id,address_id,direction,lower(from_email),authenticated);
CREATE INDEX messages_outbound_probe_idx ON messages(organization_id,address_id,direction);

-- Indexed membership probes avoid loading/scanning historical outbound JSON on every reply.
CREATE TABLE outbound_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  address_id TEXT,
  recipient TEXT NOT NULL,
  PRIMARY KEY(message_id,recipient)
);
CREATE INDEX outbound_recipients_lookup_idx ON outbound_recipients(organization_id,address_id,recipient);
INSERT OR IGNORE INTO outbound_recipients
  SELECT m.id,m.organization_id,m.address_id,lower(r.value)
  FROM messages m,json_each(m.to_emails) r WHERE m.direction='outbound' AND r.type='text';
CREATE TRIGGER outbound_recipients_insert AFTER INSERT ON messages WHEN new.direction='outbound' BEGIN
  INSERT OR IGNORE INTO outbound_recipients SELECT new.id,new.organization_id,new.address_id,lower(value)
    FROM json_each(new.to_emails) WHERE type='text';
END;
CREATE TRIGGER outbound_recipients_update AFTER UPDATE OF direction,to_emails,address_id,organization_id ON messages BEGIN
  DELETE FROM outbound_recipients WHERE message_id=old.id;
  INSERT OR IGNORE INTO outbound_recipients SELECT new.id,new.organization_id,new.address_id,lower(value)
    FROM json_each(new.to_emails) WHERE new.direction='outbound' AND type='text';
END;
