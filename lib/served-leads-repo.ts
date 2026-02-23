// ---------------------------------------------------------------------------
// Served leads deduplication repository.
//
// Tracks which CNPJs were already returned to an actor for a given search intent,
// preventing the same leads from being surfaced repeatedly to the same user.
//
// actor_id = AuthContext.actor ('session:<user_id>' or 'api_key:<label>').
// Each actor maintains an independent dedup pool, so two users on the same
// workspace each see a fresh lead pool (migration 017).
//
// Fingerprint: SHA-256 of a canonical JSON object containing the search filters.
// This groups queries that have the same effective intent (same uf + city + sector)
// even if the user phrased them differently (post-CNAE resolution).
//
// Retention window: 30 days (hardcoded; configurable per call if needed).
// ---------------------------------------------------------------------------

import { createHash } from 'crypto'
import type { PoolClient } from 'pg'

const RETENTION_DAYS = 30

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
 * Returns a Set of CNPJs already served to this actor (user) for the given
 * fingerprint within the retention window.
 *
 * actorId = AuthContext.actor — 'session:<user_id>' or 'api_key:<label>'.
 * Each actor has an independent dedup pool (migration 017).
 */
export async function getServedCnpjs(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  fingerprint: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ cnpj: string }>(
    `SELECT cnpj
     FROM agent_served_leads
     WHERE workspace_id = $1
       AND actor_id = $2
       AND query_fingerprint = $3
       AND served_at > NOW() - ($4 * INTERVAL '1 day')`,
    [workspaceId, actorId, fingerprint, RETENTION_DAYS],
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
