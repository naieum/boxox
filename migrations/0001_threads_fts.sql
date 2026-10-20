-- Keyword search: one FTS5 row per message, carrying its thread_id, ranked
-- with bm25(). Drizzle can't declare virtual tables or triggers, so they live
-- here. messages has a TEXT primary key and its implicit rowid may change on
-- VACUUM, so threads_fts_docs gives each message a stable FTS rowid.
CREATE TABLE `threads_fts_docs` (
	`doc_id` integer PRIMARY KEY,
	`message_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `threads_fts` USING fts5(
	thread_id UNINDEXED,
	subject,
	participants,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_insert` AFTER INSERT ON `messages` BEGIN
	INSERT INTO threads_fts_docs (message_id) VALUES (new.id);
	INSERT INTO threads_fts (rowid, thread_id, subject, participants, body)
	VALUES (
		(SELECT doc_id FROM threads_fts_docs WHERE message_id = new.id),
		new.thread_id,
		new.subject,
		lower(new.from_email) || ' ' || coalesce(new.from_name, '') || ' ' ||
			coalesce((SELECT group_concat(value, ' ') FROM json_each(new.to_emails)), '') || ' ' ||
			coalesce((SELECT group_concat(value, ' ') FROM json_each(new.cc_emails)), ''),
		coalesce(new.search_text, new.snippet)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_update` AFTER UPDATE OF thread_id, subject, from_email, from_name, to_emails, cc_emails, search_text, snippet ON `messages` BEGIN
	UPDATE threads_fts SET
		thread_id = new.thread_id,
		subject = new.subject,
		participants = lower(new.from_email) || ' ' || coalesce(new.from_name, '') || ' ' ||
			coalesce((SELECT group_concat(value, ' ') FROM json_each(new.to_emails)), '') || ' ' ||
			coalesce((SELECT group_concat(value, ' ') FROM json_each(new.cc_emails)), ''),
		body = coalesce(new.search_text, new.snippet)
	WHERE rowid = (SELECT doc_id FROM threads_fts_docs WHERE message_id = new.id);
END;
--> statement-breakpoint
-- Also fires for rows removed by ON DELETE CASCADE (address → thread → message).
CREATE TRIGGER `messages_fts_delete` AFTER DELETE ON `messages` BEGIN
	DELETE FROM threads_fts WHERE rowid = (SELECT doc_id FROM threads_fts_docs WHERE message_id = old.id);
	DELETE FROM threads_fts_docs WHERE message_id = old.id;
END;
--> statement-breakpoint
-- Key hierarchy: a domain key's parent must be a live management key that
-- holds the child's domain, and the child can't get permissions the parent
-- may not grant there.
CREATE TRIGGER `api_keys_parent_insert` BEFORE INSERT ON `api_keys` WHEN new.parent_key_id IS NOT NULL BEGIN
	SELECT RAISE(ABORT, 'api_keys: parent must be a live management key holding this domain')
	WHERE NOT EXISTS (
		SELECT 1 FROM api_keys p JOIN api_key_domains d ON d.api_key_id = p.id
		WHERE p.id = new.parent_key_id AND p.kind = 'management' AND p.revoked_at IS NULL AND d.domain_id = new.domain_id
	);
	SELECT RAISE(ABORT, 'api_keys: permissions exceed what the parent may grant')
	WHERE EXISTS (
		SELECT 1 FROM json_each(new.permissions) c
		WHERE c.value NOT IN (
			SELECT g.value FROM api_key_domains d, json_each(d.grantable_permissions) g
			WHERE d.api_key_id = new.parent_key_id AND d.domain_id = new.domain_id
		)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `api_keys_parent_update` BEFORE UPDATE OF parent_key_id, domain_id, permissions ON `api_keys` WHEN new.parent_key_id IS NOT NULL BEGIN
	SELECT RAISE(ABORT, 'api_keys: parent must be a management key holding this domain')
	WHERE NOT EXISTS (
		SELECT 1 FROM api_keys p JOIN api_key_domains d ON d.api_key_id = p.id
		WHERE p.id = new.parent_key_id AND p.kind = 'management' AND d.domain_id = new.domain_id
	);
	SELECT RAISE(ABORT, 'api_keys: permissions exceed what the parent may grant')
	WHERE EXISTS (
		SELECT 1 FROM json_each(new.permissions) c
		WHERE c.value NOT IN (
			SELECT g.value FROM api_key_domains d, json_each(d.grantable_permissions) g
			WHERE d.api_key_id = new.parent_key_id AND d.domain_id = new.domain_id
		)
	);
END;
