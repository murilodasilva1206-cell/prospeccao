-- Migration: Workspace API keys table
-- Bearer tokens for workspace authentication.
-- Only SHA-256(raw_key) is stored — the plaintext key is returned once at creation
-- and never persisted. Verification: hash(presented_key) == stored key_hash.

CREATE TABLE IF NOT EXISTS workspace_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,  -- SHA-256(raw_key) hex — never the plaintext key
  label        TEXT NOT NULL,         -- human-readable name (e.g. "CI Bot", "Frontend App")
  created_by   TEXT,                  -- actor who created the key (audit trail)
  revoked_at   TIMESTAMPTZ,           -- NULL = active; set to NOW() to revoke
  last_used_at TIMESTAMPTZ,           -- updated on every successful authentication
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by hash on every authenticated request (partial index — revoked rows skipped)
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_api_keys_hash
  ON workspace_api_keys(key_hash) WHERE revoked_at IS NULL;

-- List active keys for a workspace
CREATE INDEX IF NOT EXISTS idx_workspace_api_keys_workspace
  ON workspace_api_keys(workspace_id) WHERE revoked_at IS NULL;
