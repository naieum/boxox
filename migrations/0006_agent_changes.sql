-- Append-only, mailbox-scoped journal. Bodies and credentials never enter this
-- table. IDs remain after message deletion so consumers can reconcile removals.
-- Do not prune rows without adding a cursor-expiry/reset protocol first.
CREATE TABLE agent_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  address_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  visible_without_classify INTEGER NOT NULL DEFAULT 0,
  ready_for_agents INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsec') * 1000 AS integer))
);
--> statement-breakpoint
CREATE INDEX agent_changes_mailbox_seq_idx ON agent_changes(organization_id, address_id, seq);
--> statement-breakpoint
CREATE INDEX threads_agent_page_idx ON threads(organization_id, address_id, last_message_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX messages_agent_page_idx ON messages(thread_id, occurred_at, id);
--> statement-breakpoint
-- Existing mail is discoverable from an initial checkpoint after upgrading.
INSERT INTO agent_changes(organization_id, address_id, thread_id, kind)
SELECT organization_id, address_id, id, 'thread_created' FROM threads WHERE address_id IS NOT NULL ORDER BY created_at, id;
--> statement-breakpoint
CREATE TRIGGER agent_changes_thread_insert AFTER INSERT ON threads WHEN new.address_id IS NOT NULL BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind)
  VALUES(new.organization_id, new.address_id, new.id, 'thread_created');
END;
--> statement-breakpoint
-- Read receipts and updated_at alone intentionally do not wake agents.
CREATE TRIGGER agent_changes_thread_update AFTER UPDATE OF address_id, organization_id, folder, subject, snippet, message_count, last_message_at, priority, category, starred, muted, snoozed_until, counterparty_email, counterparty_name, participants ON threads
WHEN new.address_id IS NOT NULL AND (
  new.address_id IS NOT old.address_id OR new.organization_id IS NOT old.organization_id OR new.folder IS NOT old.folder OR
  new.subject IS NOT old.subject OR new.snippet IS NOT old.snippet OR new.message_count IS NOT old.message_count OR
  new.last_message_at IS NOT old.last_message_at OR new.priority IS NOT old.priority OR new.category IS NOT old.category OR
  new.starred IS NOT old.starred OR new.muted IS NOT old.muted OR new.snoozed_until IS NOT old.snoozed_until OR
  new.counterparty_email IS NOT old.counterparty_email OR new.counterparty_name IS NOT old.counterparty_name OR new.participants IS NOT old.participants
) BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind)
  VALUES(new.organization_id, new.address_id, new.id, 'thread_updated');
END;
--> statement-breakpoint
-- Capture policy before cascades remove the flagged messages.
CREATE TRIGGER agent_changes_thread_delete BEFORE DELETE ON threads WHEN old.address_id IS NOT NULL BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind, visible_without_classify, ready_for_agents)
  VALUES(old.organization_id, old.address_id, old.id, 'thread_deleted',
    CASE WHEN old.folder NOT IN ('spam', 'quarantine') AND NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.thread_id = old.id AND coalesce(json_extract(m.spam_verdict, '$.prompt_injection'), json_extract(m.spam_verdict, '$.ai.prompt_injection'), 0) >= 0.5
    ) THEN 1 ELSE 0 END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = old.id AND m.direction = 'inbound' AND m.scan_status = 'pending') THEN 1 ELSE 0 END);
END;
--> statement-breakpoint
CREATE TRIGGER agent_changes_thread_move BEFORE UPDATE OF address_id, organization_id ON threads
WHEN old.address_id IS NOT NULL AND (new.address_id IS NOT old.address_id OR new.organization_id IS NOT old.organization_id) BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind, visible_without_classify, ready_for_agents)
  VALUES(old.organization_id, old.address_id, old.id, 'thread_removed',
    CASE WHEN old.folder NOT IN ('spam', 'quarantine') AND NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.thread_id = old.id AND coalesce(json_extract(m.spam_verdict, '$.prompt_injection'), json_extract(m.spam_verdict, '$.ai.prompt_injection'), 0) >= 0.5
    ) THEN 1 ELSE 0 END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = old.id AND m.direction = 'inbound' AND m.scan_status = 'pending') THEN 1 ELSE 0 END);
END;
--> statement-breakpoint
CREATE TRIGGER agent_changes_message_insert AFTER INSERT ON messages WHEN new.address_id IS NOT NULL BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, message_id, kind)
  VALUES(new.organization_id, new.address_id, new.thread_id, new.id, 'message_created');
END;
--> statement-breakpoint
-- Verdict changes MUST append even if occurred_at is old. An agent that has
-- advanced past hidden mail must discover it when classification later clears.
CREATE TRIGGER agent_changes_message_update AFTER UPDATE OF thread_id, address_id, organization_id, spam_verdict, scan_status, send_status, delivery_status, subject, snippet, r2_key ON messages
WHEN new.address_id IS NOT NULL AND (
  new.thread_id IS NOT old.thread_id OR new.address_id IS NOT old.address_id OR new.organization_id IS NOT old.organization_id OR
  new.spam_verdict IS NOT old.spam_verdict OR new.scan_status IS NOT old.scan_status OR new.send_status IS NOT old.send_status OR new.delivery_status IS NOT old.delivery_status OR
  new.subject IS NOT old.subject OR new.snippet IS NOT old.snippet OR new.r2_key IS NOT old.r2_key
) BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, message_id, kind)
  VALUES(new.organization_id, new.address_id, new.thread_id, new.id, 'message_updated');
END;
--> statement-breakpoint
CREATE TRIGGER agent_changes_message_delete AFTER DELETE ON messages WHEN old.address_id IS NOT NULL BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, message_id, kind)
  VALUES(old.organization_id, old.address_id, old.thread_id, old.id, 'message_deleted');
END;
--> statement-breakpoint
-- Moving a flagged message can make its former thread visible without a folder
-- change, so append to BOTH scopes, including a move within the same mailbox.
CREATE TRIGGER agent_changes_message_move AFTER UPDATE OF thread_id, address_id, organization_id ON messages
WHEN old.address_id IS NOT NULL AND (new.thread_id IS NOT old.thread_id OR new.address_id IS NOT old.address_id OR new.organization_id IS NOT old.organization_id) BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, message_id, kind)
  VALUES(old.organization_id, old.address_id, old.thread_id, old.id, 'message_removed');
END;
--> statement-breakpoint
CREATE TRIGGER agent_changes_label_insert AFTER INSERT ON thread_labels BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind)
  SELECT organization_id, address_id, id, 'thread_updated' FROM threads WHERE id = new.thread_id AND address_id IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER agent_changes_label_delete AFTER DELETE ON thread_labels BEGIN
  INSERT INTO agent_changes(organization_id, address_id, thread_id, kind)
  SELECT organization_id, address_id, id, 'thread_updated' FROM threads WHERE id = old.thread_id AND address_id IS NOT NULL;
END;
