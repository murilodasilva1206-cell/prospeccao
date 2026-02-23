-- Migration: Audit log table
-- Immutable record of security-relevant actions per workspace.
-- Never updated — only inserted (append-only audit trail).

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  actor         TEXT NOT NULL,    -- 'api_key:<label>' | 'system' | 'webhook'
  action        TEXT NOT NULL,    -- see action enum below
  resource_type TEXT,             -- 'channel' | 'message' | 'api_key' | 'media'
  resource_id   TEXT,             -- UUID or other identifier
  meta          JSONB,            -- action-specific context (redacted of secrets)
  ip            TEXT,             -- client IP (from cf-connecting-ip / x-forwarded-for)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supported action values:
--   'channel.connected'        -- channel successfully connected
--   'channel.disconnected'     -- channel logged out
--   'channel.credential_rotated' -- credentials updated
--   'message.sent'             -- outbound message dispatched
--   'media.uploaded'           -- media file accepted and stored in S3
--   'api_key.created'          -- new workspace API key issued
--   'api_key.revoked'          -- API key revoked
--   'webhook.received'         -- inbound webhook processed and persisted
--   'ai.response'              -- AI agent produced a reply

-- Query audit trail for a workspace (newest first)
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace
  ON audit_log(workspace_id, created_at DESC);

-- Query by resource (e.g. all events for a specific channel)
CREATE INDEX IF NOT EXISTS idx_audit_log_resource
  ON audit_log(resource_type, resource_id);

COMMENT ON TABLE audit_log IS
  'LGPD retention: rows older than 730 days should be purged by a scheduled job.';
