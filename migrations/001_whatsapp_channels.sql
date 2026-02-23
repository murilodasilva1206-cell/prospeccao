-- Migration: WhatsApp channels table
-- Stores one record per WhatsApp channel (phone number) connected to a workspace.
-- credentials_encrypted: AES-256-GCM blob — never stored in plaintext.
-- webhook_secret: HMAC signing secret, returned to caller once at creation time.

CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           TEXT NOT NULL,
  name                   TEXT NOT NULL,
  provider               TEXT NOT NULL
                           CHECK (provider IN ('META_CLOUD', 'EVOLUTION', 'UAZAPI')),
  status                 TEXT NOT NULL DEFAULT 'DISCONNECTED'
                           CHECK (status IN (
                             'DISCONNECTED', 'PENDING_QR', 'CONNECTING', 'CONNECTED', 'ERROR'
                           )),
  phone_number           TEXT,
  external_instance_id   TEXT,
  credentials_encrypted  TEXT NOT NULL,
  webhook_secret         TEXT NOT NULL,
  last_seen_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_workspace
  ON whatsapp_channels(workspace_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_status
  ON whatsapp_channels(status);

-- Trigger: keep updated_at current on every UPDATE
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whatsapp_channels_updated_at ON whatsapp_channels;
CREATE TRIGGER trg_whatsapp_channels_updated_at
  BEFORE UPDATE ON whatsapp_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
