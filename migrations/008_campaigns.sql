-- Migration 008: Campaigns (prospecting blast campaigns)
--
-- State machine:
--   draft → awaiting_confirmation → awaiting_channel → awaiting_message
--         → ready_to_send → sending → completed | completed_with_errors | cancelled
--
-- Security:
--   - confirmation_token: must be echoed back to confirm; prevents CSRF-style auto-confirms.
--   - workspace_id: TEXT (denormalized) for fast queries, always set from auth token.
--   - channel_id FK: ensures only valid channels can be assigned.

CREATE TABLE IF NOT EXISTS campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL,
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft',
                          'awaiting_confirmation',
                          'awaiting_channel',
                          'awaiting_message',
                          'ready_to_send',
                          'sending',
                          'completed',
                          'completed_with_errors',
                          'cancelled'
                        )),
  channel_id          UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
  message_type        TEXT CHECK (message_type IN ('template', 'text')),
  message_content     JSONB,       -- { type, name, language, body_params } | { type, body }
  search_filters      JSONB,       -- filters used to build the recipient list
  total_count         INT NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  sent_count          INT NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count        INT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  confirmation_token  TEXT,        -- required to confirm; cleared after use
  created_by          TEXT NOT NULL,  -- audit: key_id that created the campaign
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- List campaigns for a workspace sorted by recency
CREATE INDEX IF NOT EXISTS idx_campaigns_workspace
  ON campaigns(workspace_id, created_at DESC);

-- Fast filter for in-progress campaigns (excludes terminal states)
CREATE INDEX IF NOT EXISTS idx_campaigns_active
  ON campaigns(workspace_id, status)
  WHERE status NOT IN ('completed', 'completed_with_errors', 'cancelled');

-- ---------------------------------------------------------------------------
-- campaign_recipients — one row per lead in the campaign
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  cnpj                 TEXT NOT NULL,
  razao_social         TEXT,
  nome_fantasia        TEXT,
  telefone             TEXT,        -- raw from CNPJ registry; normalized before send
  email                TEXT,
  municipio            TEXT,
  uf                   TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id  TEXT,        -- ID returned by WhatsApp provider on success
  error_message        TEXT,        -- error reason if status = 'failed'
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fetch pending recipients for processing
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
  ON campaign_recipients(campaign_id, status);

-- Unique: one row per CNPJ per campaign (prevents duplicate send)
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_recipients_unique
  ON campaign_recipients(campaign_id, cnpj);

-- ---------------------------------------------------------------------------
-- campaign_audit_log — immutable audit trail of all state changes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaign_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,       -- 'created' | 'confirmed' | 'channel_selected' | etc.
  performed_by TEXT NOT NULL,       -- key_id or 'system'
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_audit_campaign
  ON campaign_audit_log(campaign_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Trigger: keep updated_at current
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
