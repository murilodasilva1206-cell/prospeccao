-- Migration: Webhook events idempotency table
-- Each incoming webhook event is recorded here before processing.
-- (provider, event_id) UNIQUE prevents duplicate processing on provider retries.

CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  channel_id   UUID NOT NULL
                 REFERENCES whatsapp_channels(id) ON DELETE CASCADE,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

-- Fast lookup for idempotency check on every incoming webhook
CREATE INDEX IF NOT EXISTS idx_webhook_events_lookup
  ON webhook_events(provider, event_id);
