-- Migration: Users table
-- Stores human operator accounts for web session login (email + password).
-- Separate from workspace_api_keys (wk_...) which are for external integrations only.
--
-- Password hashing: scrypt via Node crypto — format "salt_hex:hash_hex"
-- workspace_id matches the TEXT identifier used across all other tables.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,  -- scrypt: "salt_hex:hash_hex"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast login lookup by email
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
