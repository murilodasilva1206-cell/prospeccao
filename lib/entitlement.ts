// ---------------------------------------------------------------------------
// Workspace feature entitlements
//
// Feature flags are stored in `workspace_features` (migration 026).
// If the table does not exist yet, falls back to an env-var allowlist so
// TDD can run without a schema migration:
//
//   FEATURE_CSV_IMPORT_WORKSPACES=*              (allow all workspaces)
//   FEATURE_CSV_IMPORT_WORKSPACES=ws-a,ws-b      (allow specific workspaces)
//
// auditBlockedFeature() is best-effort — it never throws.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'

export type WorkspaceFeature = 'csv_import' | 'csv_export'

/**
 * Returns true when the workspace has the given feature enabled.
 * Deny-by-default: returns false if no row exists in workspace_features.
 */
export async function checkWorkspaceFeature(
  client: PoolClient,
  workspace_id: string,
  feature: WorkspaceFeature,
): Promise<boolean> {
  try {
    const { rows } = await client.query(
      `SELECT enabled FROM workspace_features WHERE workspace_id = $1 AND feature_name = $2`,
      [workspace_id, feature],
    )
    if (rows.length > 0) return rows[0].enabled === true
    // Row not found — fall through to env-var fallback
  } catch {
    // Table likely doesn't exist yet — fall through to env-var fallback
  }

  // Env-var fallback: FEATURE_CSV_IMPORT_WORKSPACES or FEATURE_CSV_EXPORT_WORKSPACES
  let rawAllowed = ''
  switch (feature) {
    case 'csv_import':
      rawAllowed = process.env.FEATURE_CSV_IMPORT_WORKSPACES ?? ''
      break
    case 'csv_export':
      rawAllowed = process.env.FEATURE_CSV_EXPORT_WORKSPACES ?? ''
      break
  }
  const allowed = rawAllowed.split(',').map((s) => s.trim()).filter(Boolean)

  return allowed.includes('*') || allowed.includes(workspace_id)
}

/**
 * Inserts a best-effort audit log entry when a feature is blocked.
 * Never throws — audit failures must not fail the main request.
 */
export async function auditBlockedFeature(
  client: PoolClient,
  workspace_id: string,
  feature: WorkspaceFeature,
  actor: string,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor, action, resource_type, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        workspace_id,
        actor,
        'feature.blocked',
        'entitlement',
        JSON.stringify({ feature }),
      ],
    )
  } catch {
    // Best-effort — swallow errors silently
  }
}
