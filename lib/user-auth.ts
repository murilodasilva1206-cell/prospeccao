// ---------------------------------------------------------------------------
// User authentication — password hashing and DB operations
//
// Password format: "salt_hex:hash_hex"
//   salt: 16 random bytes as hex (32 chars)
//   hash: scrypt(password, salt, 64) as hex (128 chars)
//
// Uses Node built-in crypto — no additional dependencies.
// ---------------------------------------------------------------------------

import { scrypt, randomBytes, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import type { PoolClient } from 'pg'

const scryptAsync = promisify(scrypt)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string
  workspace_id: string
  email: string
  created_at: Date
}

export interface CreateUserInput {
  workspace_id: string
  email: string
  password: string
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hashes a plaintext password using scrypt.
 * Returns "salt_hex:hash_hex" — safe to store in DB.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer
  return `${salt}:${derivedKey.toString('hex')}`
}

/**
 * Verifies a plaintext password against a stored hash.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [salt, hash] = storedHash.split(':')
  if (!salt || !hash) return false
  try {
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer
    const storedBuffer = Buffer.from(hash, 'hex')
    if (derivedKey.length !== storedBuffer.length) return false
    return timingSafeEqual(derivedKey, storedBuffer)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Creates a new user.
 * Returns the persisted record (without password_hash).
 */
export async function createUser(
  client: PoolClient,
  input: CreateUserInput,
): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password)

  const result = await client.query<UserRecord & { password_hash: string }>(
    `INSERT INTO users (workspace_id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, workspace_id, email, created_at`,
    [input.workspace_id, input.email.toLowerCase().trim(), passwordHash],
  )

  const { ...record } = result.rows[0]
  return record
}

/**
 * Looks up a user by email.
 * Returns the full record including password_hash for verification.
 * Returns null if not found.
 */
export async function findUserByEmail(
  client: PoolClient,
  email: string,
): Promise<(UserRecord & { password_hash: string }) | null> {
  const result = await client.query<UserRecord & { password_hash: string }>(
    `SELECT id, workspace_id, email, password_hash, created_at
     FROM users
     WHERE email = $1`,
    [email.toLowerCase().trim()],
  )

  return result.rows[0] ?? null
}

/**
 * Returns the count of users in the DB.
 * Used to gate the bootstrap /api/auth/register endpoint.
 */
export async function countUsers(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users',
  )
  return parseInt(result.rows[0].count, 10)
}
