-- Migration 020: hot-path partial indexes for cnpj_completo (28 M rows)
--
-- Partial indexes (WHERE situacao_cadastral = '02' AND tem_telefone = true)
-- cover the dominant query shape from the agent: active businesses with phone.
-- The smaller index footprint means faster builds, lower I/O, and better
-- cache hit rates than full-table composite indexes.
--
-- Run ONCE on the production database.  Statements are idempotent.
--
-- IMPORTANT: CONCURRENTLY cannot run inside a transaction block.
-- Execute each statement separately in psql or your migration runner.
--
-- Expected build time (Postgres 14+, 28 M rows, SSD):
--   Each index  ~60–180 s (non-blocking — uses ShareUpdateExclusiveLock)
--
-- If previous versions of these indexes exist with a different definition,
-- drop them first:
--   DROP INDEX IF EXISTS public.idx_cnpj_hot_uf_mun_cnae_ord;
--   DROP INDEX IF EXISTS public.idx_cnpj_hot_uf_mun_ord;
-- Then re-run this migration.
--
-- After applying, run: ANALYZE public.cnpj_completo;
-- Validate with:       EXPLAIN (ANALYZE, BUFFERS) <agent query>;
--
-- Pre-requisite: migration 018 (pg_trgm + idx_cnpj_cnae_digits).

-- ---------------------------------------------------------------------------
-- 1. uf + municipio + cnae (digit-normalised) + ORDER BY
--
--    Covers:
--      WHERE uf = $1
--        AND municipio = $2                  ← numeric codigo_rf from resolver
--        AND regexp_replace(cnae_principal, '[^0-9]', '', 'g') = ANY($3::text[])
--        AND situacao_cadastral = '02'       ← captured in partial condition
--        AND tem_telefone = true             ← captured in partial condition
--      ORDER BY razao_social ASC, cnpj_completo ASC
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cnpj_hot_uf_mun_cnae_ord
    ON public.cnpj_completo (
        uf,
        municipio,
        (regexp_replace(cnae_principal, '[^0-9]', '', 'g')),
        razao_social,
        cnpj_completo
    )
    WHERE situacao_cadastral = '02' AND tem_telefone = true;

-- ---------------------------------------------------------------------------
-- 2. uf + municipio + ORDER BY  (no cnae filter)
--
--    Covers:
--      WHERE uf = $1
--        AND municipio = $2                  ← numeric codigo_rf from resolver
--        AND situacao_cadastral = '02'       ← captured in partial condition
--        AND tem_telefone = true             ← captured in partial condition
--      ORDER BY razao_social ASC, cnpj_completo ASC
--
--    Also used when the planner does a bitmap scan combining this index with
--    idx_cnpj_cnae_digits (migration 018) for queries that add a cnae filter
--    but skip the municipio filter.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cnpj_hot_uf_mun_ord
    ON public.cnpj_completo (uf, municipio, razao_social, cnpj_completo)
    WHERE situacao_cadastral = '02' AND tem_telefone = true;
