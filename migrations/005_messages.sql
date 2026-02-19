-- Migration: Messages table
-- Canonical message model — provider-agnostic, supports all message types.
-- Inbound messages arrive via webhook; outbound messages are sent via API.

CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id          UUID NOT NULL REFERENCES whatsapp_channels(id) ON DELETE CASCADE,
  provider_message_id TEXT,             -- provider-assigned ID (NULL while queued)
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type        TEXT NOT NULL CHECK (message_type IN (
                        'text', 'image', 'audio', 'video',
                        'document', 'sticker', 'reaction'
                      )),
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                        'queued', 'sent', 'delivered', 'read', 'failed'
                      )),
  body                TEXT,             -- text content or reaction emoji; NULL for media-only
  media_s3_key        TEXT,             -- S3 object key (private bucket, use signed URL)
  media_mime_type     TEXT,             -- validated MIME type
  media_filename      TEXT,             -- original filename (sanitized)
  media_size_bytes    BIGINT,           -- file size in bytes
  reaction_to_msg_id  UUID REFERENCES messages(id), -- for reactions: target message
  sent_by             TEXT,             -- 'webhook' | 'ai' | 'human:<actor_id>'
  ai_decision_log     JSONB,            -- set when sent_by='ai'; full reasoning chain
  raw_event           JSONB,            -- original normalized event payload (for debug/audit)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Timeline view: messages in a conversation sorted oldest-first
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at ASC);

-- Status updates via provider message ID
CREATE INDEX IF NOT EXISTS idx_messages_provider_id
  ON messages(channel_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- LGPD retention candidate index (purge job: DELETE WHERE created_at < NOW() - INTERVAL '365 days')
CREATE INDEX IF NOT EXISTS idx_messages_retention
  ON messages(created_at);

COMMENT ON TABLE messages IS
  'LGPD retention: rows older than 365 days should be purged by a scheduled job.';

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS trg_messages_updated_at ON messages;
CREATE TRIGGER trg_messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
