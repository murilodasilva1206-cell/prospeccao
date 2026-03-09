-- Migration 023: Lead pools — persisted snapshots of agent search results.
--
-- A lead pool is a named, workspace-scoped list of PublicEmpresa objects
-- returned by /api/agente. It allows operators to save a search result without
-- immediately starting a campaign (e.g. review later, share with team,
-- source multiple campaigns from the same pool).
--
-- leads_json stores the array of PublicEmpresa objects (already masked via
-- maskContact). No raw Receita Federal data — only the 10 public fields.
-- lead_count is a denormalized counter set at INSERT time to avoid COUNT(*)
-- on the JSONB array in list views.
--
-- Run ONCE on the production database.

CREATE TABLE IF NOT EXISTS lead_pools (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  query_fingerprint TEXT,
  filters_json      JSONB,
  leads_json        JSONB       NOT NULL DEFAULT '[]',
  lead_count        INT         NOT NULL DEFAULT 0 CHECK (lead_count >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- List view: workspace pools ordered by most recent
CREATE INDEX IF NOT EXISTS idx_lead_pools_workspace
  ON lead_pools (workspace_id, created_at DESC);

-- Lookup by fingerprint (optional future dedup of identical searches)
CREATE INDEX IF NOT EXISTS idx_lead_pools_fingerprint
  ON lead_pools (workspace_id, query_fingerprint)
  WHERE query_fingerprint IS NOT NULL;

-- Auto-update updated_at (function already created by migration 001)
DROP TRIGGER IF EXISTS trg_lead_pools_updated_at ON lead_pools;
CREATE TRIGGER trg_lead_pools_updated_at
  BEFORE UPDATE ON lead_pools
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
