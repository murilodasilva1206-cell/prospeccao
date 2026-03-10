-- ---------------------------------------------------------------------------
-- Migration 024: whatsapp_templates
--
-- Stores Meta Cloud API message templates synced via
-- GET /{waba_id}/message_templates.
-- One row per (workspace_id, channel_id, template_name, language).
-- Soft-delete: is_active=false when a template disappears from provider.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT        NOT NULL,
  channel_id        UUID        NOT NULL REFERENCES whatsapp_channels(id) ON DELETE CASCADE,

  -- Template identity (unique key from Meta)
  template_name     TEXT        NOT NULL,
  language          TEXT        NOT NULL,  -- e.g. 'pt_BR', 'en_US'

  -- Metadata from Meta API
  status            TEXT        NOT NULL,  -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED
  category          TEXT        NOT NULL,  -- MARKETING | UTILITY | AUTHENTICATION

  -- Full component array as returned by Meta (HEADER, BODY, FOOTER, BUTTONS)
  components        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Derived: count of {{N}} placeholders in the BODY component
  variables_count   INTEGER     NOT NULL DEFAULT 0,

  -- Soft-delete: false when template no longer returned by provider sync
  is_active         BOOLEAN     NOT NULL DEFAULT true,

  -- Timestamps
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per (workspace, channel, name, language)
  UNIQUE (workspace_id, channel_id, template_name, language)
);

-- Index for list/filter queries (most common access pattern)
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_channel
  ON whatsapp_templates (channel_id, is_active, status);

-- Index for name search
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_name
  ON whatsapp_templates (workspace_id, channel_id, template_name);
