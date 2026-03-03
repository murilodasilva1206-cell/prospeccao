-- Migration 019: indexes for mapeamento_municipios + unaccent extension
--
-- Run ONCE on the production database.  All statements are idempotent
-- (CREATE EXTENSION / INDEX IF NOT EXISTS).
--
-- Expected build time (5570 municipalities):
--   Extension creation   < 1 s
--   B-tree indexes       < 1 s each
--   Expression B-tree    ~1–2 s
--
-- ---------------------------------------------------------------------------
-- 1. Extensions required by the resolver
-- ---------------------------------------------------------------------------

-- unaccent: used by the resolver SQL to strip accents before matching
CREATE EXTENSION IF NOT EXISTS unaccent;

-- pg_trgm: allows GIN index to accelerate ILIKE with leading wildcards
--          (already created in migration 018 for cnpj_completo; safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. Composite index: uf + nome_municipio
--    Used by: WHERE uf = $1 AND nome_municipio ILIKE $2
--    Both columns present in the most common resolver query.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_map_mun_uf_nome
    ON mapeamento_municipios (uf, nome_municipio);

-- ---------------------------------------------------------------------------
-- 3. Index on codigo_rf
--    Used by: lookups that start from a code (reverse resolution, future use).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_map_mun_codigo_rf
    ON mapeamento_municipios (codigo_rf);

-- ---------------------------------------------------------------------------
-- 4. Expression index on unaccent(lower(nome_municipio))
--    Mirrors the normalisation applied in the resolver SQL so the planner can
--    use an index scan for equality lookups (exact name match after unaccent).
--    ILIKE with leading wildcards still falls through to the trigram index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_map_mun_nome_unaccent
    ON mapeamento_municipios ((unaccent(lower(nome_municipio))));

-- ---------------------------------------------------------------------------
-- 5. GIN trigram index on unaccent(lower(nome_municipio))
--    Enables ILIKE '%texto%' queries without a full table scan.
--    Pairs with the unaccent function applied to the search term in the resolver.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_map_mun_nome_trgm
    ON mapeamento_municipios USING gin (
        (unaccent(lower(nome_municipio))) gin_trgm_ops
    );
