-- Migration 016: Agent served leads deduplication
-- Tracks which CNPJs were returned to each workspace per search intent fingerprint.
-- Prevents the same leads from being surfaced repeatedly for identical queries.
--
-- Fingerprint = SHA-256(canonical JSON of {uf, municipio, cnae_principal, nicho, situacao_cadastral})
-- Window: leads are excluded if served within the last 30 days (configurable in application code).

CREATE TABLE agent_served_leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT        NOT NULL,
  query_fingerprint TEXT        NOT NULL,    -- SHA-256 hex of canonical filter JSON
  cnpj              TEXT        NOT NULL,
  served_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A given CNPJ is only tracked once per workspace+fingerprint combination.
  -- ON CONFLICT DO NOTHING is used on insert.
  UNIQUE (workspace_id, query_fingerprint, cnpj)
);

-- Primary lookup: find already-served CNPJs for a workspace + fingerprint
CREATE INDEX agent_served_leads_lookup_idx
  ON agent_served_leads(workspace_id, query_fingerprint, served_at);

-- Cleanup index: allows efficient DELETE of rows older than the retention window
CREATE INDEX agent_served_leads_served_at_idx
  ON agent_served_leads(served_at);
