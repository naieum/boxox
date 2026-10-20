-- OAuth credentials are envelope-encrypted with an installation-specific key.
CREATE TABLE cloudflare_connections (
  account_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credentials TEXT NOT NULL,
  refresh_lock TEXT,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, organization_id, user_id)
);
