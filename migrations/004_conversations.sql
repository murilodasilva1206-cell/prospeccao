-- Migration: Conversations table
-- One row per (channel_id, contact_phone) pair.
-- Tracks the active conversation thread between a channel and a contact.

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES whatsapp_channels(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL,         -- denormalized for fast workspace queries
  contact_phone   TEXT NOT NULL,         -- external phone number (no leading +)
  contact_name    TEXT,                  -- display name from provider (may be null)
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'resolved', 'ai_handled')),
  last_message_at TIMESTAMPTZ,           -- updated on every new message (for sort)
  unread_count    INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  ai_enabled      BOOLEAN NOT NULL DEFAULT false, -- whether AI auto-reply is active
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, contact_phone)     -- one conversation per contact per channel
);

-- List conversations for a channel sorted by recency
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(channel_id, last_message_at DESC NULLS LAST);

-- List all conversations for a workspace (inbox view)
CREATE INDEX IF NOT EXISTS idx_conversations_workspace
  ON conversations(workspace_id, last_message_at DESC NULLS LAST);

-- Filter by status
CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON conversations(workspace_id, status) WHERE status != 'resolved';

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
