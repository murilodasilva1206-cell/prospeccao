-- Migration: Web sessions table
-- Server-side sessions for human operator logins.
-- Only SHA-256(raw_token) is stored — the raw session token is sent via HttpOnly cookie.
-- Verification: SHA-256(presented_token) === stored session_token_hash
--
-- Sessions expire after 8 hours (28800 seconds).
-- Expiry is enforced in application code; an index on expires_at enables efficient cleanup.

CREATE TABLE IF NOT EXISTS web_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL,
  session_token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256(raw_token) hex
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on expires_at for efficient expired-session cleanup and filtering.
-- Note: a partial index with WHERE expires_at > NOW() is not allowed because
-- NOW() is not IMMUTABLE — Postgres requires IMMUTABLE predicates on partial indexes.
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at
  ON web_sessions(expires_at);

-- Note: no separate index on session_token_hash — the UNIQUE constraint above
-- already creates a B-tree index that serves fast lookup by token.
