// ---------------------------------------------------------------------------
// LLM profile repository — CRUD for llm_profiles table.
//
// Security:
//   - API keys are stored AES-256-GCM encrypted (same key as channel credentials).
//   - Raw API keys are never returned to callers; only key_hint (last 4 chars).
//   - workspace_id always comes from the authenticated token, never from input.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import type { PoolClient } from 'pg'
import type { LlmCallConfig, LlmProvider } from './llm-providers'

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM, same scheme as lib/whatsapp/crypto.ts)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function getEncryptionKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}

function encryptApiKey(rawKey: string): string {
  const iv = randomBytes(IV_BYTES)
  const key = getEncryptionKey()
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('base64')].join(':')
}

function decryptApiKey(blob: string): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted key blob format')
  const [ivHex, tagHex, cipherBase64] = parts

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(cipherBase64, 'base64')

  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length')
  if (authTag.length !== TAG_BYTES) throw new Error('Invalid auth tag length')

  const key = getEncryptionKey()
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

function keyHint(rawKey: string): string {
  return `...${rawKey.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LlmProfilePublic {
  id: string
  workspace_id: string
  name: string
  provider: LlmProvider
  key_hint: string  // last 4 chars of the raw API key, e.g. "...k3z9"
  model: string
  base_url: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface LlmProfileCreateInput {
  name: string
  provider: LlmProvider
  api_key: string
  model: string
  base_url?: string | null
  is_default?: boolean
}

export interface LlmProfileUpdateInput {
  name?: string
  provider?: LlmProvider
  api_key?: string
  model?: string
  base_url?: string | null
  is_default?: boolean
}

// ---------------------------------------------------------------------------
// Row → public shape
// ---------------------------------------------------------------------------

interface LlmProfileRow {
  id: string
  workspace_id: string
  name: string
  provider: string
  api_key_encrypted: string
  model: string
  base_url: string | null
  is_default: boolean
  created_at: Date
  updated_at: Date
}

function rowToPublic(row: LlmProfileRow): LlmProfilePublic {
  const rawKey = decryptApiKey(row.api_key_encrypted)
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    provider: row.provider as LlmProvider,
    key_hint: keyHint(rawKey),
    model: row.model,
    base_url: row.base_url,
    is_default: row.is_default,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listProfiles(
  client: PoolClient,
  workspaceId: string,
): Promise<LlmProfilePublic[]> {
  const { rows } = await client.query<LlmProfileRow>(
    `SELECT * FROM llm_profiles WHERE workspace_id = $1 ORDER BY is_default DESC, created_at ASC`,
    [workspaceId],
  )
  return rows.map(rowToPublic)
}

export async function createProfile(
  client: PoolClient,
  workspaceId: string,
  input: LlmProfileCreateInput,
): Promise<LlmProfilePublic> {
  const encrypted = encryptApiKey(input.api_key)
  const isDefault = input.is_default ?? false

  if (isDefault) {
    // Swap default atomically: clear old → insert new. Without a transaction the
    // partial-unique index (WHERE is_default = true) would reject the new INSERT
    // before the old default is cleared.
    await client.query('BEGIN')
    try {
      await client.query(
        `UPDATE llm_profiles SET is_default = false WHERE workspace_id = $1 AND is_default = true`,
        [workspaceId],
      )
      const { rows } = await client.query<LlmProfileRow>(
        `INSERT INTO llm_profiles
           (workspace_id, name, provider, api_key_encrypted, model, base_url, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING *`,
        [workspaceId, input.name, input.provider, encrypted, input.model, input.base_url ?? null],
      )
      await client.query('COMMIT')
      return rowToPublic(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  }

  const { rows } = await client.query<LlmProfileRow>(
    `INSERT INTO llm_profiles
       (workspace_id, name, provider, api_key_encrypted, model, base_url, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     RETURNING *`,
    [workspaceId, input.name, input.provider, encrypted, input.model, input.base_url ?? null],
  )
  return rowToPublic(rows[0])
}

export async function updateProfile(
  client: PoolClient,
  id: string,
  workspaceId: string,
  input: LlmProfileUpdateInput,
): Promise<LlmProfilePublic | null> {
  // Fetch the existing row first so we can merge partial updates
  const { rows: existing } = await client.query<LlmProfileRow>(
    `SELECT * FROM llm_profiles WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  )
  if (existing.length === 0) return null

  const row = existing[0]
  const newEncrypted = input.api_key !== undefined
    ? encryptApiKey(input.api_key)
    : row.api_key_encrypted

  const newIsDefault = input.is_default !== undefined ? input.is_default : row.is_default
  const mergedParams = [
    id,
    workspaceId,
    input.name     ?? row.name,
    input.provider ?? row.provider,
    newEncrypted,
    input.model    ?? row.model,
    'base_url' in input ? (input.base_url ?? null) : row.base_url,
    newIsDefault,
  ]

  if (newIsDefault && !row.is_default) {
    // Setting a new default — clear the current one first in a transaction to
    // avoid violating the partial-unique index (WHERE is_default = true).
    await client.query('BEGIN')
    try {
      await client.query(
        `UPDATE llm_profiles SET is_default = false WHERE workspace_id = $1 AND is_default = true AND id != $2`,
        [workspaceId, id],
      )
      const { rows } = await client.query<LlmProfileRow>(
        `UPDATE llm_profiles
         SET name              = $3,
             provider          = $4,
             api_key_encrypted = $5,
             model             = $6,
             base_url          = $7,
             is_default        = $8
         WHERE id = $1 AND workspace_id = $2
         RETURNING *`,
        mergedParams,
      )
      await client.query('COMMIT')
      return rows.length > 0 ? rowToPublic(rows[0]) : null
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  }

  const { rows } = await client.query<LlmProfileRow>(
    `UPDATE llm_profiles
     SET name              = $3,
         provider          = $4,
         api_key_encrypted = $5,
         model             = $6,
         base_url          = $7,
         is_default        = $8
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    mergedParams,
  )
  return rows.length > 0 ? rowToPublic(rows[0]) : null
}

export async function deleteProfile(
  client: PoolClient,
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM llm_profiles WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Returns the decrypted LlmCallConfig for the default profile of a workspace.
 * Returns null if the workspace has no profiles configured.
 */
export async function getDefaultProfile(
  client: PoolClient,
  workspaceId: string,
): Promise<LlmCallConfig | null> {
  const { rows } = await client.query<LlmProfileRow>(
    `SELECT * FROM llm_profiles WHERE workspace_id = $1 AND is_default = true LIMIT 1`,
    [workspaceId],
  )
  if (rows.length === 0) return null

  const row = rows[0]
  const apiKey = decryptApiKey(row.api_key_encrypted)
  return {
    apiKey,
    model: row.model,
    provider: row.provider as LlmProvider,
    baseUrl: row.base_url ?? undefined,
  }
}

/**
 * Returns the decrypted LlmCallConfig for a specific profile ID.
 * Returns null if not found or not owned by the workspace.
 */
export async function getProfileConfig(
  client: PoolClient,
  id: string,
  workspaceId: string,
): Promise<LlmCallConfig | null> {
  const { rows } = await client.query<LlmProfileRow>(
    `SELECT * FROM llm_profiles WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  )
  if (rows.length === 0) return null

  const row = rows[0]
  const apiKey = decryptApiKey(row.api_key_encrypted)
  return {
    apiKey,
    model: row.model,
    provider: row.provider as LlmProvider,
    baseUrl: row.base_url ?? undefined,
  }
}
