-- Migration 010: Add processing_started_at to campaign_recipients
--
-- Enables lease-timeout recovery for 'processing' recipients that were claimed
-- but never finalised due to a worker crash or network failure.
-- The claim query (claimPendingRecipients) re-claims any processing row whose
-- lease is older than 10 minutes, returning it to circulation.

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Index to efficiently find stuck/expired leases during claim queries.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_stuck
  ON campaign_recipients(campaign_id, processing_started_at)
  WHERE status = 'processing';
