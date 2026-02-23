-- Migration 017: Add actor_id to agent_served_leads for per-user deduplication
--
-- Previously, deduplication was shared across the entire workspace (any actor
-- that had already been served a CNPJ would not see it again, even if a
-- different user on the same workspace never received it).
--
-- With actor_id, each operator/integration has their own deduplicated view
-- of the lead pool, fulfilling the "cada usuário usa a própria chave" requirement.
--
-- actor_id = AuthContext.actor — 'session:<user_id>' or 'api_key:<label>'

-- 1. Add the column (NOT NULL with empty-string default covers existing rows)
ALTER TABLE agent_served_leads
  ADD COLUMN IF NOT EXISTS actor_id TEXT NOT NULL DEFAULT '';

-- 2. Drop the old workspace-level unique constraint
ALTER TABLE agent_served_leads
  DROP CONSTRAINT IF EXISTS agent_served_leads_workspace_id_query_fingerprint_cnpj_key;

-- 3. New unique constraint now scoped per-actor
ALTER TABLE agent_served_leads
  ADD CONSTRAINT agent_served_leads_actor_dedup_key
    UNIQUE (workspace_id, actor_id, query_fingerprint, cnpj);

-- 4. Refresh lookup index to include actor_id
DROP INDEX IF EXISTS agent_served_leads_lookup_idx;
CREATE INDEX agent_served_leads_lookup_idx
  ON agent_served_leads(workspace_id, actor_id, query_fingerprint, served_at);

-- Cleanup index stays the same
-- agent_served_leads_served_at_idx already exists from migration 016
