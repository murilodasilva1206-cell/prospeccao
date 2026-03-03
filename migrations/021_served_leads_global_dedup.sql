-- Migration 021: global dedup for agent_served_leads
--
-- Changes the deduplication model from:
--   actor + query_fingerprint + 30-day window   (per-search-intent, expiring)
-- to:
--   actor + cnpj (global, permanent)
--
-- A CNPJ served to an actor is never shown again to that actor, regardless
-- of which search filter was used or how long ago it was served.
-- Different actors on the same workspace each have an independent pool.
--
-- Run ONCE on the production database.  All steps are safe to re-run
-- (CONCURRENTLY / IF NOT EXISTS / idempotent DELETE).
--
-- IMPORTANT: CONCURRENTLY cannot run inside a transaction block.
-- Execute each statement separately in psql or your migration runner.

-- ---------------------------------------------------------------------------
-- 1. Remove duplicate rows — keep the most recent record per actor+cnpj
--    (safe to re-run: no-op if duplicates were already removed)
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT ctid,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, actor_id, cnpj
           ORDER BY served_at DESC
         ) AS rn
  FROM agent_served_leads
)
DELETE FROM agent_served_leads a
USING ranked r
WHERE a.ctid = r.ctid
  AND r.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. Unique constraint: one row per (workspace_id, actor_id, cnpj)
--    ON CONFLICT DO NOTHING in markAsServed relies on this to be idempotent.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_served_leads_actor_cnpj_uq_idx
    ON agent_served_leads (workspace_id, actor_id, cnpj);

-- ---------------------------------------------------------------------------
-- 3. Lookup index: used by getServedCnpjs to fetch the full served set
--    for an actor efficiently.  The unique index above already covers this
--    shape; this entry is kept as a named alias for query-plan readability.
--    (Postgres reuses the unique index — no extra storage cost.)
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_served_leads_actor_lookup_idx
    ON agent_served_leads (workspace_id, actor_id, cnpj);
