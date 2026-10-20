CREATE TABLE `address_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text,
	`invite_email` text,
	`permissions` text DEFAULT '["read"]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `address_grants_address_idx` ON `address_grants` (`address_id`);--> statement-breakpoint
CREATE INDEX `address_grants_principal_idx` ON `address_grants` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE INDEX `address_grants_invite_idx` ON `address_grants` (`invite_email`);--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`local_part` text NOT NULL,
	`kind` text DEFAULT 'role' NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer,
	`delivery_mode` text DEFAULT 'inbox' NOT NULL,
	`ai_opt_out` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_domain_local_idx` ON `addresses` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE INDEX `addresses_org_idx` ON `addresses` (`organization_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`declared_type` text,
	`detected_type` text NOT NULL,
	`size` integer NOT NULL,
	`risk` text NOT NULL,
	`content_id` text,
	`inline` integer DEFAULT false NOT NULL,
	`text_r2_key` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_sha256_idx` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `blocked_senders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_senders_org_email_idx` ON `blocked_senders` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `blocked_senders_org_idx` ON `blocked_senders` (`organization_id`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`region` text,
	`active` integer DEFAULT true NOT NULL,
	`unknown_mail_policy` text DEFAULT 'hold' NOT NULL,
	`catch_all_address_id` text,
	`last_synced_at` integer,
	`sending_enabled` integer DEFAULT false NOT NULL,
	`receiving_enabled` integer DEFAULT false NOT NULL,
	`track_opens` integer DEFAULT false NOT NULL,
	`track_clicks` integer DEFAULT false NOT NULL,
	`health` text,
	`health_checked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`catch_all_address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_org_name_idx` ON `domains` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX `domains_org_idx` ON `domains` (`organization_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`thread_id` text,
	`reply_to_message_id` text,
	`mode` text DEFAULT 'new' NOT NULL,
	`to_emails` text DEFAULT '[]' NOT NULL,
	`cc_emails` text DEFAULT '[]' NOT NULL,
	`bcc_emails` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text,
	`attachments_meta` text DEFAULT '[]' NOT NULL,
	`scheduled_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_thread_idx` ON `drafts` (`thread_id`) WHERE "drafts"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `drafts_address_idx` ON `drafts` (`address_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_idx` ON `labels` (lower("name"));--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`address_id` text,
	`direction` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text,
	`authenticated` integer DEFAULT false NOT NULL,
	`new_participant` integer DEFAULT false NOT NULL,
	`to_emails` text DEFAULT '[]' NOT NULL,
	`cc_emails` text DEFAULT '[]' NOT NULL,
	`bcc_emails` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`references` text,
	`r2_key` text NOT NULL,
	`raw_mime_key` text,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`search_text` text,
	`has_html` integer DEFAULT false NOT NULL,
	`has_text` integer DEFAULT false NOT NULL,
	`attachments_meta` text DEFAULT '[]' NOT NULL,
	`sent_message_id` text,
	`send_status` text,
	`scheduled_at` integer,
	`delivery_status` text,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`spam_verdict` text,
	`send_attempts` integer DEFAULT 0 NOT NULL,
	`send_error` text,
	`dedupe_scope` text NOT NULL,
	`occurred_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `messages_org_idx` ON `messages` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `messages_rfc_id_idx` ON `messages` (`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `messages_org_addr_rfc_idx` ON `messages` (`organization_id`,`address_id`,`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `messages_sent_message_id_idx` ON `messages` (`sent_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe_idx` ON `messages` (`organization_id`,`dedupe_scope`,`rfc_message_id`);--> statement-breakpoint
CREATE TABLE `operational_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operational_events_org_idx` ON `operational_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`message_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_hash_unique` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_expires_idx` ON `share_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `thread_labels` (
	`thread_id` text NOT NULL,
	`label_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`thread_id`, `label_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_labels_label_idx` ON `thread_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `thread_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`source_thread_id` text,
	`target_thread_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_overrides_kind_check" CHECK(("thread_overrides"."kind" = 'split' AND "thread_overrides"."message_id" IS NOT NULL) OR ("thread_overrides"."kind" = 'merge' AND "thread_overrides"."source_thread_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `thread_overrides_message_idx` ON `thread_overrides` (`message_id`);--> statement-breakpoint
CREATE INDEX `thread_overrides_source_idx` ON `thread_overrides` (`source_thread_id`);--> statement-breakpoint
CREATE INDEX `thread_overrides_target_idx` ON `thread_overrides` (`target_thread_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`address_id` text,
	`domain_id` text,
	`original_recipient` text,
	`subject` text DEFAULT '' NOT NULL,
	`subject_norm` text DEFAULT '' NOT NULL,
	`counterparty_email` text,
	`counterparty_name` text,
	`participants` text DEFAULT '[]' NOT NULL,
	`folder` text DEFAULT 'inbox' NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`unread` integer DEFAULT true NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`snoozed_until` integer,
	`priority` integer,
	`category` text,
	`summary` text,
	`summary_message_count` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`last_message_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `threads_org_folder_idx` ON `threads` (`organization_id`,`folder`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `threads_address_idx` ON `threads` (`address_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `threads_subject_norm_idx` ON `threads` (`address_id`,`subject_norm`);--> statement-breakpoint
CREATE INDEX `threads_trash_purge_idx` ON `threads` (`updated_at`) WHERE "threads"."folder" = 'trash';--> statement-breakpoint
CREATE TABLE `agent_pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pairing_codes_code_hash_unique` ON `agent_pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `agent_pairing_codes_agent_idx` ON `agent_pairing_codes` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_rate_hits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`send_hourly_cap` integer,
	`send_daily_cap` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_client_id_unique` ON `agents` (`client_id`);--> statement-breakpoint
CREATE INDEX `agents_org_idx` ON `agents` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mcp_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`name` text NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`revoked_at` integer,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_clients_agent_idx` ON `mcp_clients` (`agent_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata` text,
	`ip_address` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_org_created_idx` ON `audit_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`);--> statement-breakpoint
CREATE TABLE `api_key_domains` (
	`api_key_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`grantable_permissions` text DEFAULT '[]' NOT NULL,
	`daily_send_budget` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`api_key_id`, `domain_id`),
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_key_domains_domain_idx` ON `api_key_domains` (`domain_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`domain_id` text,
	`parent_key_id` text,
	`secret_hash` text NOT NULL,
	`previous_secret_hash` text,
	`previous_secret_expires_at` integer,
	`prefix` text NOT NULL,
	`last4` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`allowed_from` text DEFAULT '[]' NOT NULL,
	`allowed_recipients` text DEFAULT '[]' NOT NULL,
	`ip_allowlist` text DEFAULT '[]' NOT NULL,
	`rate_limit_per_minute` integer,
	`daily_send_cap` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`last_used_ip` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "api_keys_kind_check" CHECK(("api_keys"."kind" = 'domain' AND "api_keys"."domain_id" IS NOT NULL) OR ("api_keys"."kind" = 'management' AND "api_keys"."domain_id" IS NULL AND "api_keys"."parent_key_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_secret_hash_unique` ON `api_keys` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_previous_secret_hash_unique` ON `api_keys` (`previous_secret_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_domain_idx` ON `api_keys` (`domain_id`);--> statement-breakpoint
CREATE INDEX `api_keys_parent_idx` ON `api_keys` (`parent_key_id`);--> statement-breakpoint
CREATE TABLE `api_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`api_key_id` text,
	`from_email` text NOT NULL,
	`to_emails` text DEFAULT '[]' NOT NULL,
	`cc_emails` text DEFAULT '[]' NOT NULL,
	`bcc_emails` text DEFAULT '[]' NOT NULL,
	`reply_to` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '{}' NOT NULL,
	`template_id` text,
	`r2_key` text NOT NULL,
	`track_opens` integer DEFAULT false NOT NULL,
	`track_clicks` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`scheduled_at` integer,
	`sent_message_id` text,
	`send_attempts` integer DEFAULT 0 NOT NULL,
	`send_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_messages_domain_created_idx` ON `api_messages` (`domain_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `api_messages_domain_status_idx` ON `api_messages` (`domain_id`,`status`);--> statement-breakpoint
CREATE INDEX `api_messages_sent_message_id_idx` ON `api_messages` (`sent_message_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_key_idx` ON `idempotency_keys` (`api_key_id`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`api_message_id` text,
	`type` text NOT NULL,
	`recipient` text,
	`detail` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_message_id`) REFERENCES `api_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_events_target_check" CHECK(("message_events"."message_id" IS NULL) <> ("message_events"."api_message_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `message_events_message_idx` ON `message_events` (`message_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `message_events_api_message_idx` ON `message_events` (`api_message_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_domain_email_idx` ON `suppressions` (`domain_id`,`email`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`html` text,
	`text` text,
	`variables` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_domain_name_version_idx` ON `templates` (`domain_id`,`name`,`version`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`attempt_log` text DEFAULT '[]' NOT NULL,
	`last_status_code` integer,
	`delivered_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_event_idx` ON `webhook_deliveries` (`webhook_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_pending_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`url` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`secret` text NOT NULL,
	`previous_secret` text,
	`previous_secret_expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhooks_domain_idx` ON `webhooks` (`domain_id`);--> statement-breakpoint
CREATE TABLE `sender_reputation` (
	`email` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`inbound_count` integer DEFAULT 0 NOT NULL,
	`outbound_count` integer DEFAULT 0 NOT NULL,
	`spam_count` integer DEFAULT 0 NOT NULL,
	`ham_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sender_reputation_domain_idx` ON `sender_reputation` (`domain`);--> statement-breakpoint
CREATE TABLE `spam_fingerprints` (
	`id` text PRIMARY KEY NOT NULL,
	`algorithm` text NOT NULL,
	`hash` text NOT NULL,
	`message_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `spam_fingerprints_hash_idx` ON `spam_fingerprints` (`algorithm`,`hash`);--> statement-breakpoint
CREATE TABLE `spam_models` (
	`name` text NOT NULL,
	`variant` text DEFAULT 'default' NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`fitted_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`name`, `variant`)
);
--> statement-breakpoint
CREATE TABLE `spam_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`spam_count` integer DEFAULT 0 NOT NULL,
	`ham_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spam_training` (
	`message_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`trained_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`local_filters` integer,
	`local_filters_changed_at` integer,
	`reputation_lookups` integer,
	`reputation_lookups_changed_at` integer,
	`ai` integer,
	`ai_changed_at` integer,
	`provider` text,
	`models` text DEFAULT '{}' NOT NULL,
	`only_when_uncertain` integer DEFAULT true NOT NULL,
	`daily_budget_micros` integer DEFAULT 1000000 NOT NULL,
	`owner_rules` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "ai_settings_singleton_check" CHECK("ai_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`setup_completed_at` integer,
	`agents_disabled` integer DEFAULT false NOT NULL,
	`sending_paused_at` integer,
	`sending_paused_reason` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "app_settings_singleton_check" CHECK("app_settings"."id" = 1)
);
