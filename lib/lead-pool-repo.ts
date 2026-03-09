// ---------------------------------------------------------------------------
// Lead pool repository — all DB access for the lead_pools table.
// Only parameterized SQL ($N). Never interpolates user input into query text.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadPool {
  id: string
  workspace_id: string
  name: string
  query_fingerprint: string | null
  filters_json: Record<string, unknown> | null
  lead_count: number
  created_at: Date
  updated_at: Date
}

export interface LeadPoolDetail extends LeadPool {
  leads_json: PublicEmpresa[]
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToLeadPool(row: Record<string, unknown>): LeadPool {
  return {
    id:               row.id as string,
    workspace_id:     row.workspace_id as string,
    name:             row.name as string,
    query_fingerprint: (row.query_fingerprint as string | null) ?? null,
    filters_json:     (row.filters_json as Record<string, unknown> | null) ?? null,
    lead_count:       Number(row.lead_count ?? 0),
    created_at:       new Date(row.created_at as string),
    updated_at:       new Date(row.updated_at as string),
  }
}

function rowToLeadPoolDetail(row: Record<string, unknown>): LeadPoolDetail {
  return {
    ...rowToLeadPool(row),
    leads_json: (row.leads_json as PublicEmpresa[]) ?? [],
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Create a new lead pool and return it (without leads_json — call findLeadPoolById for detail).
 */
export async function createLeadPool(
  client: PoolClient,
  input: {
    workspace_id: string
    name: string
    query_fingerprint?: string | null
    filters_json?: Record<string, unknown> | null
    leads: PublicEmpresa[]
  },
): Promise<LeadPool> {
  const { rows } = await client.query(
    `INSERT INTO lead_pools
       (workspace_id, name, query_fingerprint, filters_json, leads_json, lead_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, workspace_id, name, query_fingerprint, filters_json, lead_count, created_at, updated_at`,
    [
      input.workspace_id,
      input.name,
      input.query_fingerprint ?? null,
      input.filters_json ? JSON.stringify(input.filters_json) : null,
      JSON.stringify(input.leads),
      input.leads.length,
    ],
  )
  return rowToLeadPool(rows[0])
}

/**
 * List lead pools for a workspace (without leads_json — saves bandwidth in list views).
 * workspace_id in WHERE is the authorization anchor.
 */
export async function findLeadPoolsByWorkspace(
  client: PoolClient,
  workspace_id: string,
  limit = 20,
  offset = 0,
): Promise<LeadPool[]> {
  const { rows } = await client.query(
    `SELECT id, workspace_id, name, query_fingerprint, filters_json, lead_count, created_at, updated_at
     FROM lead_pools
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [workspace_id, limit, offset],
  )
  return rows.map(rowToLeadPool)
}

export async function countLeadPools(
  client: PoolClient,
  workspace_id: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS total FROM lead_pools WHERE workspace_id = $1`,
    [workspace_id],
  )
  return Number(rows[0]?.total ?? 0)
}

/**
 * Fetch a single lead pool including its leads_json.
 * workspace_id anchor prevents cross-workspace reads.
 */
export async function findLeadPoolById(
  client: PoolClient,
  id: string,
  workspace_id: string,
): Promise<LeadPoolDetail | null> {
  const { rows } = await client.query(
    `SELECT * FROM lead_pools WHERE id = $1 AND workspace_id = $2`,
    [id, workspace_id],
  )
  return rows.length > 0 ? rowToLeadPoolDetail(rows[0]) : null
}

/**
 * Find the most recent pool matching a query_fingerprint within N hours.
 * Used for auto-save dedup: avoids creating duplicate pools for the same search.
 * Returns null if no matching pool exists in the time window.
 */
export async function findRecentPoolByFingerprint(
  client: PoolClient,
  workspace_id: string,
  fingerprint: string,
  withinHours = 24,
): Promise<LeadPool | null> {
  const { rows } = await client.query(
    `SELECT id, workspace_id, name, query_fingerprint, filters_json, lead_count, created_at, updated_at
     FROM lead_pools
     WHERE workspace_id      = $1
       AND query_fingerprint  = $2
       AND created_at        >= NOW() - ($3 || ' hours')::interval
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspace_id, fingerprint, String(withinHours)],
  )
  return rows.length > 0 ? rowToLeadPool(rows[0]) : null
}

/**
 * Delete a lead pool. workspace_id anchor prevents cross-workspace deletes.
 * Returns true if a row was deleted, false if not found or wrong workspace.
 */
export async function deleteLeadPool(
  client: PoolClient,
  id: string,
  workspace_id: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM lead_pools WHERE id = $1 AND workspace_id = $2`,
    [id, workspace_id],
  )
  return (rowCount ?? 0) > 0
}
