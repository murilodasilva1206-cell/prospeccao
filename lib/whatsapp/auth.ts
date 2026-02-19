// ---------------------------------------------------------------------------
// Workspace API key management
//
// Key format:  wk_<64 hex chars>  (32 random bytes)
// Storage:     SHA-256(raw_key) hex stored in workspace_api_keys.key_hash
// Verification: hash(presented_key) === stored key_hash
//
// The raw key is returned ONCE at creation and never stored.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'crypto'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string
  workspace_id: string
  key_hash: string
  label: string
  created_by: string | null
  revoked_at: Date | null
  last_used_at: Date | null
  created_at: Date
}

export interface CreateApiKeyInput {
  workspace_id: string
  label: string
  created_by?: string
}

export interface ValidatedKey {
  workspace_id: string
  label: string
  key_id: string
}

// ---------------------------------------------------------------------------
// Key generation and hashing
// ---------------------------------------------------------------------------

/** Generates a new raw API key: "wk_" prefix + 32 random bytes as hex. */
export function generateApiKey(): { rawKey: string; keyHash: string } {
  const raw = randomBytes(32).toString('hex')
  const rawKey = `wk_${raw}`
  const keyHash = hashApiKey(rawKey)
  return { rawKey, keyHash }
}

/** Deterministic SHA-256 hash of a raw API key. Never store the raw key itself. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Creates a new API key for a workspace.
 * Returns the raw key (shown once) and the persisted record (without the raw key).
 */
export async function createApiKey(
  client: PoolClient,
  input: CreateApiKeyInput,
): Promise<{ key: string; record: Omit<ApiKeyRecord, 'key_hash'> }> {
  const { rawKey, keyHash } = generateApiKey()

  const result = await client.query<ApiKeyRecord>(
    `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, workspace_id, key_hash, label, created_by, revoked_at, last_used_at, created_at`,
    [input.workspace_id, keyHash, input.label, input.created_by ?? null],
  )

  const row = result.rows[0]
  // Never return key_hash to callers
  const { key_hash: _, ...record } = row
  return { key: rawKey, record }
}

/**
 * Validates a raw API key presented in a request.
 * Returns the workspace identity on success, or null if the key is unknown/revoked.
 * Also updates last_used_at for audit tracking.
 */
export async function validateApiKey(
  client: PoolClient,
  rawKey: string,
): Promise<ValidatedKey | null> {
  const keyHash = hashApiKey(rawKey)

  const result = await client.query<{
    id: string
    workspace_id: string
    label: string
  }>(
    `UPDATE workspace_api_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, workspace_id, label`,
    [keyHash],
  )

  if (result.rows.length === 0) return null

  const row = result.rows[0]
  return { workspace_id: row.workspace_id, label: row.label, key_id: row.id }
}

/**
 * Revokes an API key by setting revoked_at = NOW().
 * The workspaceId guard ensures a caller cannot revoke keys owned by another workspace.
 * Returns true if the key was found and revoked, false if not found or workspace mismatch.
 */
export async function revokeApiKey(
  client: PoolClient,
  keyId: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE workspace_api_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [keyId, workspaceId],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Lists all active (non-revoked) API keys for a workspace.
 * Never returns key_hash.
 */
export async function listApiKeys(
  client: PoolClient,
  workspace_id: string,
): Promise<Omit<ApiKeyRecord, 'key_hash'>[]> {
  const result = await client.query<Omit<ApiKeyRecord, 'key_hash'>>(
    `SELECT id, workspace_id, label, created_by, revoked_at, last_used_at, created_at
     FROM workspace_api_keys
     WHERE workspace_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [workspace_id],
  )
  return result.rows
}
