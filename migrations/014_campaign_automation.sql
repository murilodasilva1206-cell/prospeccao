-- Migration 014: Campaign Automation
--
-- Adds autonomous sending infrastructure to campaigns:
--   - Automation config: delay, jitter, rate limits, working hours
--   - Retry tracking on recipients (retryable errors: 5xx, 429, timeout)
--   - next_send_at: cron-controlled send gate (Vercel Cron fires every minute)
--   - paused_at: audit timestamp for pause events
--   - New status 'paused': sending → paused → sending (resume)
--
-- Cancel is now allowed from 'sending' and 'paused' (updated at application layer).
--
-- Idempotent: all ADD COLUMN use IF NOT EXISTS; DROP CONSTRAINT uses IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1. Automation config columns on campaigns
-- ---------------------------------------------------------------------------

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS automation_delay_seconds          INTEGER     NOT NULL DEFAULT 120
    CHECK (automation_delay_seconds >= 10 AND automation_delay_seconds <= 86400),
  ADD COLUMN IF NOT EXISTS automation_jitter_max             INTEGER     NOT NULL DEFAULT 20
    CHECK (automation_jitter_max >= 0 AND automation_jitter_max <= 300),
  ADD COLUMN IF NOT EXISTS automation_max_per_hour           INTEGER     NOT NULL DEFAULT 30
    CHECK (automation_max_per_hour >= 1 AND automation_max_per_hour <= 500),
  ADD COLUMN IF NOT EXISTS automation_working_hours_start    SMALLINT
    CHECK (automation_working_hours_start BETWEEN 0 AND 23),
  ADD COLUMN IF NOT EXISTS automation_working_hours_end      SMALLINT
    CHECK (automation_working_hours_end   BETWEEN 0 AND 23),
  ADD COLUMN IF NOT EXISTS max_retries                       INTEGER     NOT NULL DEFAULT 3
    CHECK (max_retries >= 0 AND max_retries <= 10),
  ADD COLUMN IF NOT EXISTS next_send_at                      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_at                         TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. Extend status enum to include 'paused'
--    PostgreSQL inline CHECK constraints get the auto-generated name
--    <table>_<column>_check — drop (if exists) and recreate with the new value set.
-- ---------------------------------------------------------------------------

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check CHECK (status IN (
  'draft',
  'awaiting_confirmation',
  'awaiting_channel',
  'awaiting_message',
  'ready_to_send',
  'sending',
  'paused',
  'completed',
  'completed_with_errors',
  'cancelled'
));

-- ---------------------------------------------------------------------------
-- 3. Retry tracking on campaign_recipients
-- ---------------------------------------------------------------------------

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS retry_count   INTEGER     NOT NULL DEFAULT 0
    CHECK (retry_count >= 0),
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

-- Cron fast-path: only 'sending' campaigns with an elapsed next_send_at
CREATE INDEX IF NOT EXISTS idx_campaigns_sendable
  ON campaigns (next_send_at, status)
  WHERE status = 'sending';

-- Retry eligible recipients (pending but delayed)
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_retry
  ON campaign_recipients (campaign_id, next_retry_at)
  WHERE status = 'pending' AND next_retry_at IS NOT NULL;
