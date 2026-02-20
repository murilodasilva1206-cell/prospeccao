// ---------------------------------------------------------------------------
// Web session management
//
// Session token format: 32 random bytes as hex (64 chars)
// Storage: SHA-256(raw_token) stored in web_sessions.session_token_hash
// Cookie: raw_token sent as HttpOnly, Secure, SameSite=Strict
//
// Same security model as workspace_api_keys:
//   present raw token → hash → DB lookup
//   even if DB is compromised, raw tokens are not exposed.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'crypto'
import type { PoolClient } from 'pg'

// Session TTL: 8 hours
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidatedSession {
  session_id: string
  user_id: string
  workspace_id: string
}

// ---------------------------------------------------------------------------
// Token generation and hashing
// ---------------------------------------------------------------------------

/** Generates a raw session token: 32 random bytes as hex (64 chars). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** Deterministic SHA-256 hash of a raw session token. Never store the raw token. */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Creates a new web session for a user.
 * Returns the raw session token (to be set in the cookie — never stored).
 */
export async function createWebSession(
  client: PoolClient,
  input: { user_id: string; workspace_id: string },
): Promise<string> {
  const rawToken = generateSessionToken()
  const tokenHash = hashSessionToken(rawToken)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await client.query(
    `INSERT INTO web_sessions (user_id, workspace_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.user_id, input.workspace_id, tokenHash, expiresAt],
  )

  return rawToken
}

/**
 * Validates a raw session token from a cookie.
 * Returns session info if valid and not expired, null otherwise.
 */
export async function validateWebSession(
  client: PoolClient,
  rawToken: string,
): Promise<ValidatedSession | null> {
  if (!rawToken || rawToken.length !== 64) return null

  const tokenHash = hashSessionToken(rawToken)

  const result = await client.query<{
    id: string
    user_id: string
    workspace_id: string
    expires_at: Date
  }>(
    `SELECT id, user_id, workspace_id, expires_at
     FROM web_sessions
     WHERE session_token_hash = $1 AND expires_at > NOW()`,
    [tokenHash],
  )

  if (result.rows.length === 0) return null

  const row = result.rows[0]
  return {
    session_id: row.id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
  }
}

/**
 * Deletes a session by its raw token (logout).
 * No-op if the token is unknown or already expired.
 */
export async function deleteWebSession(
  client: PoolClient,
  rawToken: string,
): Promise<void> {
  if (!rawToken) return
  const tokenHash = hashSessionToken(rawToken)
  await client.query(
    'DELETE FROM web_sessions WHERE session_token_hash = $1',
    [tokenHash],
  )
}

/**
 * Looks up user email for a given session (for /api/auth/me).
 */
export async function getSessionUser(
  client: PoolClient,
  rawToken: string,
): Promise<{ workspace_id: string; email: string; user_id: string } | null> {
  if (!rawToken || rawToken.length !== 64) return null

  const tokenHash = hashSessionToken(rawToken)

  const result = await client.query<{
    workspace_id: string
    email: string
    user_id: string
  }>(
    `SELECT s.workspace_id, u.email, u.id AS user_id
     FROM web_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash],
  )

  return result.rows[0] ?? null
}
