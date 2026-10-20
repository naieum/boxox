-- Durable dispatch ledger. Raw MIME stays in R2 even when dispatch is unavailable.
CREATE TABLE ingest_jobs (
  raw_key TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('staging','pending','running','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  message_id TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'none' CHECK(enrichment_status IN ('none','pending','running','complete','failed'))
);
CREATE INDEX ingest_jobs_dispatch_idx ON ingest_jobs(status, next_attempt_at, updated_at);
CREATE INDEX ingest_jobs_status_updated_idx ON ingest_jobs(status, updated_at, raw_key);
CREATE INDEX ingest_jobs_enrichment_idx ON ingest_jobs(enrichment_status, updated_at);
CREATE INDEX ingest_jobs_completed_idx ON ingest_jobs(completed_at DESC) WHERE completed_at IS NOT NULL;
