-- Migration 018: performance indexes for cnpj_completo (28 M rows)
--
-- Run this migration ONCE on the production database before deploying the
-- application changes. Each index is created with IF NOT EXISTS so the
-- script is safe to re-run.
--
-- Expected build time (Postgres 14+, 28 M rows, SSD):
--   B-tree scalar indexes  ~30–90 s each
--   Expression B-tree      ~60–120 s
--   GIN trigram indexes    ~120–300 s each (sequential build, no lock on reads)
--
-- All CREATE INDEX statements are non-blocking in Postgres ≥ 9.2 when run
-- outside a transaction (they use ShareUpdateExclusiveLock, not AccessExclusive).
-- Run each statement separately if you need to monitor progress via pg_stat_progress_create_index.

-- ---------------------------------------------------------------------------
-- 1. Trigram extension (required for ILIKE with leading wildcards)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. Exact-match scalar indexes
--    Used by: situacao_cadastral = $N, uf = $N
--    Also used by COUNT(*) when these filters are present.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_situacao
    ON cnpj_completo (situacao_cadastral);

CREATE INDEX IF NOT EXISTS idx_cnpj_uf
    ON cnpj_completo (uf);

-- ---------------------------------------------------------------------------
-- 3. Boolean column indexes
--    Used by: tem_telefone = true/false, tem_email = true/false
--    Low-cardinality columns — partial indexes would be more selective but
--    the planner ignores them when the filter matches the majority of rows.
--    Full B-tree is fine here; true rows (~60 %) are always filtered with other
--    high-selectivity predicates (uf + situacao_cadastral).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_tem_telefone
    ON cnpj_completo (tem_telefone);

CREATE INDEX IF NOT EXISTS idx_cnpj_tem_email
    ON cnpj_completo (tem_email);

-- ---------------------------------------------------------------------------
-- 4. Composite index: uf + situacao_cadastral
--    This is the most common predicate combination (both filters are always
--    present in agent queries: uf from the user, situacao_cadastral defaults
--    to '02'). The composite index beats two separate scans by returning
--    filtered rows in a single index range scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_uf_situacao
    ON cnpj_completo (uf, situacao_cadastral);

-- ---------------------------------------------------------------------------
-- 5. Expression index for CNAE digit normalisation
--    Mirrors the regexp_replace used in query-builder.ts so the planner can
--    use an index scan for equality lookups. The leading-wildcard ILIKE used
--    in partial-CNAE searches still needs the trigram index below.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_cnae_digits
    ON cnpj_completo ((regexp_replace(cnae_principal, '[^0-9]', '', 'g')));

-- ---------------------------------------------------------------------------
-- 6. GIN trigram index for municipio ILIKE '%...%'
--    pg_trgm turns any ILIKE pattern (including leading wildcards) into a
--    set intersection of trigrams, allowing index-assisted scans instead of
--    a full sequential scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_municipio_trgm
    ON cnpj_completo USING gin (municipio gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 7. GIN trigram index for CNAE digit expression ILIKE '%...%'
--    Supports partial CNAE lookups (e.g. user sends "863" to match 8630504).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cnpj_cnae_digits_trgm
    ON cnpj_completo USING gin (
        (regexp_replace(cnae_principal, '[^0-9]', '', 'g')) gin_trgm_ops
    );
