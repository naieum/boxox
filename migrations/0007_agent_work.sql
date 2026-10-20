-- Work acknowledgments are independent of a person's read/unread mailbox state.
-- A group is either agent:<id> or an explicitly shared group:<name>.
CREATE TABLE agent_work (
  organization_id TEXT NOT NULL,
  consumer_key TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('leased', 'pending', 'completed')),
  owner_agent_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  available_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, consumer_key, message_id)
);
CREATE INDEX agent_work_address_state ON agent_work (organization_id, address_id, consumer_key, state, available_at, lease_until);
CREATE INDEX messages_agent_work_page ON messages (organization_id, address_id, direction, occurred_at, id);
