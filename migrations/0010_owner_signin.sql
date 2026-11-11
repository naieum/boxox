-- Box Ox sign-in, for installations that do not put Cloudflare Access in front of the app.
-- A person is an email address; the owner is the one equal to OWNER_EMAIL.
CREATE TABLE auth_users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- WebAuthn credentials. The public key cannot sign anyone in by itself.
CREATE TABLE auth_passkeys (
  credential_id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX auth_passkeys_user_idx ON auth_passkeys(user_email);

-- Only a SHA-256 of the session cookie is stored.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_email);

-- Single-use links that let one person create a passkey: the owner's from the
-- installer, members' from the owner. Only a SHA-256 of the code is stored.
CREATE TABLE auth_invites (
  code_hash TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX auth_invites_user_idx ON auth_invites(user_email);
