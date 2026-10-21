export interface IngestParams {
  /** R2 key of the raw message; doubles as the workflow instance id. */
  rawKey: string;
  receivedAt: string;
}

export interface EnrichParams { rawKey: string; messageId: string; }

export interface SendParams {
  /** "api": an api_messages row from /dev/v1/messages; absent: a mailbox message. */
  kind?: "api";
  messageId: string;
  /** ISO instant; absent sends immediately. */
  scheduledAt?: string;
}

export interface SnoozeParams {
  threadId: string;
  /** ISO instant the thread returns to the inbox. */
  until: string;
}

export interface Env {
  /** Selected at deployment. Absent on legacy full installations. */
  BOXOX_EDITION?: "free" | "paid";
  /** SQLite Durable Object for Free-profile CPU work. */
  FREE_RUNTIME?: DurableObjectNamespace<import("./do/free-runtime").FreeRuntime>;
  /** Source commit recorded by scripts/deploy.sh. */
  BUILD_SHA?: string;
  /** Installer identity allowed to manage this single-tenant installation. */
  OWNER_EMAIL?: string;
  /** Cloudflare Access application audience tag; the app fails closed without it. */
  ACCESS_AUD?: string;
  /** Access team domain, e.g. https://you.cloudflareaccess.com. */
  TEAM_DOMAIN?: string;
  /** Used by /setup to onboard zones; the app works without it after setup. */
  CF_API_TOKEN?: string;
  /** Installation-owned Cloudflare API OAuth client (Authorization Code + PKCE). */
  CF_OAUTH_CLIENT_ID?: string;
  WORKER_NAME?: string;
  EVENTS_QUEUE?: string;
  INGEST_QUEUE_NAME?: string;
  /** Bound simultaneously dispatched inbound Workflows, default 8; allowed 1..64. */
  INGEST_MAX_CONCURRENCY?: string;
  /** Indexed characters per message, 0..65536; originals in R2 are unaffected. */
  SEARCH_BODY_CHAR_LIMIT?: string;
  /** 'off' skips attachment text conversion on future enrichment runs. */
  INDEX_ATTACHMENT_TEXT?: string;
  AGENT_SEND_LIMIT_PER_15_MIN?: string;
  WEBHOOK_QUEUE_NAME?: string;
  MAIL_BUCKET?: string;
  CF_ACCOUNT_ID?: string;
  /** 32-byte base64 HS256 secret for agent JWTs only; agent routes 503 when absent. */
  AGENT_JWT_SECRET?: string;
  /**
   * 32-byte base64 root for every other key, each derived with its own label:
   * signed links and image-proxy URLs, tracking tokens, raw-download URLs,
   * the domain-connection cookie, Cloudflare OAuth token sealing and webhook
   * secret sealing. Kept apart from AGENT_JWT_SECRET so a leak of either
   * cannot be used for the other's purposes. Without it links and remote
   * images are stripped, tracking is off, and those features refuse to run.
   */
  BOXOX_SIGNING_SECRET?: string;
  /** The Worker's public origin, for links in sent mail (tracking); tracking stays off without it. */
  PUBLIC_URL?: string;
  /** Optional Spamhaus DQS key; ZEN/DBL lookups are skipped without it. */
  SPAMHAUS_DQS_KEY?: string;
  /** Static assets (built SPA). */
  ASSETS: Fetcher;
  /** Metadata, keyword search. */
  DB: D1Database;
  /** Raw mail, bodies, attachments. */
  MAIL_STORE: R2Bucket;
  /** OAuth provider state, OpenPhish feed. */
  KV: KVNamespace;
  AI: Ai;
  /** Semantic search is optional; keyword search works without this index. */
  VECTORS?: Vectorize;
  /** Browser Run quick actions: on-demand link previews and PDF export; both 503 without it. */
  BROWSER?: BrowserRun;
  EMAIL: SendEmail;
  INGEST_WORKFLOW: Workflow<IngestParams>;
  ENRICH_WORKFLOW?: Workflow<EnrichParams>;
  /** Paid-profile burst buffer; Free uses direct Workflow dispatch. */
  INGEST_QUEUE?: Queue<{ rawKey: string }>;
  SEND_WORKFLOW: Workflow<SendParams>;
  SNOOZE_WORKFLOW: Workflow<SnoozeParams>;
  /** Standard Webhooks deliveries, one attempt per message. */
  WEBHOOK_QUEUE: Queue<{ deliveryId: string }>;
  MAILBOX_HUB: DurableObjectNamespace<import("./do/mailbox-hub").MailboxHub>;
  INBOUND_RATE_LIMIT: RateLimit;
  INBOUND_GLOBAL_RATE_LIMIT: RateLimit;
  AGENT_RATE_LIMIT: RateLimit;
  ANALYTICS: AnalyticsEngineDataset;
}
