-- Migration: LGPD data retention policy markers
-- This migration documents the retention policy and creates supporting indexes.
-- Actual deletion must be performed by a scheduled external job (pg_cron or similar).
--
-- Retention schedule:
--   messages:  DELETE WHERE created_at < NOW() - INTERVAL '365 days'
--   audit_log: DELETE WHERE created_at < NOW() - INTERVAL '730 days'
--
-- Before deletion, consider whether a data subject access request (DSAR) is pending.

COMMENT ON TABLE messages IS
  'LGPD Art. 15 — dados de mensagens retidos por 365 dias. '
  'Expurgo via job externo: DELETE FROM messages WHERE created_at < NOW() - INTERVAL ''365 days''.';

COMMENT ON TABLE audit_log IS
  'LGPD Art. 37 — registros de operações retidos por 730 dias. '
  'Expurgo via job externo: DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL ''730 days''.';

-- Additional index to make the retention purge query efficient (already created in 005/006,
-- this migration is idempotent if re-run after those migrations).
CREATE INDEX IF NOT EXISTS idx_audit_log_retention
  ON audit_log(created_at);
