-- Migration 009: Add 'processing' status to campaign_recipients
--
-- Required for atomic claim (FOR UPDATE SKIP LOCKED) to prevent duplicate sends
-- when concurrent POST /send requests race for the same pending recipients.
-- Recipients transition: pending → processing (claim) → sent | failed | skipped (result).

ALTER TABLE campaign_recipients
  DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;

ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped'));
