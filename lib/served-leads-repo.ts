// ---------------------------------------------------------------------------
// Served leads deduplication repository.
//
// Tracks which CNPJs were already returned to an actor, preventing the same
// leads from being surfaced again to the same user regardless of search intent.
//
// actor_id = AuthContext.actor ('session:<user_id>' or 'api_key:<label>').
// Each actor maintains an independent dedup pool, so two users on the same
// workspace each see a fresh lead pool (migrations 017 + 021).
//
// Dedup model (migration 021): global per actor+cnpj — a CNPJ served to an
// actor is excluded forever, independent of query_fingerprint or time window.
// query_fingerprint is still recorded in markAsServed for audit/analytics.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import type { PoolClient } from 'pg'

export interface ServedLeadsFilters {
  uf?: string | null
  municipio?: string | null
  cnae_principal?: string | null
  nicho?: string | null
  situacao_cadastral?: string | null
}

/**
 * Strips diacritics (accents) from a string, then lowercases and trims it.
 * Ensures "São Paulo" and "Sao Paulo" produce the same fingerprint.
 */
function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

/**
 * Builds a stable SHA-256 fingerprint for a set of search filters.
 * The canonical form is sorted, accent-normalized, and lowercased so that
 * minor phrasing variations ("São Paulo" vs "Sao Paulo") share one pool.
 */
export function buildQueryFingerprint(filters: ServedLeadsFilters): string {
  const canonical = JSON.stringify({
    uf:                 filters.uf?.toUpperCase() ?? null,
    municipio:          filters.municipio ? normalizeText(filters.municipio) : null,
    cnae_principal:     filters.cnae_principal ?? null,
    nicho:              filters.nicho ? normalizeText(filters.nicho) : null,
    situacao_cadastral: filters.situacao_cadastral ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Returns a Set of ALL CNPJs ever served to this actor (global, no expiry).
 *
 * actorId = AuthContext.actor — 'session:<user_id>' or 'api_key:<label>'.
 * Each actor has an independent dedup pool (migrations 017 + 021).
 *
 * Note: for very active actors this set can grow large.  Future improvement:
 * push exclusion to SQL with a NOT EXISTS / anti-join to avoid loading the
 * full set into Node.js memory.
 */
export async function getServedCnpjs(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ cnpj: string }>(
    `SELECT cnpj
     FROM agent_served_leads
     WHERE workspace_id = $1
       AND actor_id = $2`,
    [workspaceId, actorId],
  )
  return new Set(rows.map((r) => r.cnpj))
}

/**
 * Records a batch of CNPJs as served for this actor + fingerprint.
 * Uses ON CONFLICT DO NOTHING to safely handle concurrent requests.
 *
 * actorId = AuthContext.actor — 'session:<user_id>' or 'api_key:<label>'.
 */
export async function markAsServed(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  fingerprint: string,
  cnpjs: string[],
): Promise<void> {
  if (cnpjs.length === 0) return

  const valueRows: string[] = []
  const params: unknown[] = [workspaceId, actorId, fingerprint]
  cnpjs.forEach((cnpj, i) => {
    valueRows.push(`($1, $2, $3, $${i + 4})`)
    params.push(cnpj)
  })

  await client.query(
    `INSERT INTO agent_served_leads (workspace_id, actor_id, query_fingerprint, cnpj)
     VALUES ${valueRows.join(', ')}
     ON CONFLICT DO NOTHING`,
    params,
  )
}
