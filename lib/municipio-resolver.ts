// ---------------------------------------------------------------------------
// Municipio resolver — converts a free-text municipality name to the numeric
// codigo_f used in the cnpj_completo table.
//
// The resolver queries `mapeamento_municipios` with unaccent + ILIKE so that
// "São Paulo", "sao paulo", and "SAO PAULO" all resolve to the same code.
// Numeric inputs (already a code) are returned without a DB round-trip.
//
// Requires: `unaccent` extension + migration 019 indexes.
// If the table/extension is not available, the resolver returns `not_found`
// and logs a warning so the caller can degrade gracefully.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import { logger } from './logger'

export interface MunicipioCandidate {
  codigo: string
  nome: string
  uf: string
}

export type MunicipioResult =
  | { type: 'found';     codigo: string; nome: string; uf: string }
  | { type: 'ambiguous'; candidates: MunicipioCandidate[] }
  | { type: 'not_found' }

const NUMERIC_RE = /^\d+$/

const RESOLVER_SQL = `
  SELECT codigo_f       AS codigo,
         nome_municipio AS nome,
         uf
  FROM   mapeamento_municipios
  WHERE  ($1::text IS NULL OR uf = $1)
    AND  unaccent(lower(nome_municipio)) ILIKE unaccent(lower($2))
  ORDER BY
    CASE WHEN unaccent(lower(nome_municipio)) = unaccent(lower($2)) THEN 0 ELSE 1 END,
    nome_municipio
  LIMIT 5
`

/**
 * Resolves a municipality name or numeric code against `mapeamento_municipios`.
 *
 * Rules:
 *   - Numeric input → returned as-is (no DB round-trip).
 *   - 0 rows → `not_found` — caller should ask the user to rephrase.
 *   - 1 row → `found`.
 *   - >1 rows, UF not given → `ambiguous` — caller should ask for the UF.
 *   - >1 rows, UF given → `found` (exact match wins via ORDER BY).
 *
 * @param client  Existing PoolClient — caller owns the lifecycle (connect/release).
 * @param nome    Municipality name or numeric code from the user/AI.
 * @param uf      Optional 2-letter state code to disambiguate homophones.
 */
export async function resolveMunicipio(
  client: PoolClient,
  nome: string,
  uf?: string,
): Promise<MunicipioResult> {
  const trimmed = nome.trim()

  // Numeric codes pass through without a DB lookup — the query builder will use
  // an exact-match predicate (`municipio = $N`) instead of ILIKE.
  if (NUMERIC_RE.test(trimmed)) {
    return { type: 'found', codigo: trimmed, nome: trimmed, uf: uf ?? '' }
  }

  let rows: MunicipioCandidate[]
  try {
    const result = await client.query<MunicipioCandidate>(
      RESOLVER_SQL,
      [uf ?? null, `%${trimmed}%`],
    )
    rows = result.rows
  } catch (err) {
    // Graceful degradation when mapeamento_municipios or unaccent are not available.
    logger.warn(
      { err: err instanceof Error ? err.message : err, nome, uf },
      'municipio-resolver: DB query failed — table or unaccent extension not available; falling back to ILIKE',
    )
    return { type: 'not_found' }
  }

  if (rows.length === 0) return { type: 'not_found' }

  if (rows.length === 1) {
    return { type: 'found', codigo: rows[0].codigo, nome: rows[0].nome, uf: rows[0].uf }
  }

  // Multiple matches without a UF filter → ambiguous.
  // With UF the WHERE clause already scopes to a single state, so we pick
  // the best result (exact-match first, alphabetical fallback).
  if (!uf) {
    return { type: 'ambiguous', candidates: rows }
  }

  return { type: 'found', codigo: rows[0].codigo, nome: rows[0].nome, uf: rows[0].uf }
}
