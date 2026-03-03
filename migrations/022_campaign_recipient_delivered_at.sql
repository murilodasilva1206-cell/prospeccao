-- Migration 022 — Add delivered_at to campaign_recipients
--
-- Records when the provider confirmed delivery (delivered or read webhook).
-- Used by the delivery watchdog to distinguish "sent but not yet confirmed"
-- from "confirmed delivered" — preventing false timeout_sem_entrega failures.
--
-- NULL   = not yet confirmed delivered (may timeout after DELIVERY_TIMEOUT_MINUTES)
-- NOT NULL = delivery confirmed; watchdog will skip this recipient

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Index: speeds up the watchdog query that filters on (status='sent' AND delivered_at IS NULL)
CREATE INDEX IF NOT EXISTS campaign_recipients_sent_undelivered_idx
  ON campaign_recipients (campaign_id, sent_at)
  WHERE status = 'sent' AND delivered_at IS NULL;
