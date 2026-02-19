// ---------------------------------------------------------------------------
// AES-256-GCM credential encryption — zero external dependencies.
//
// Key source: CREDENTIALS_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
// Stored format: "<ivHex>:<authTagHex>:<ciphertextBase64>"
//
// Security properties:
//   - Each encryption call uses a fresh 96-bit IV (randomBytes).
//   - GCM auth tag prevents ciphertext tampering (authenticated encryption).
//   - Decryption throws on any tag mismatch — active tamper detection.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto'
import type { ChannelCredentials } from './types'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12   // 96-bit IV — NIST recommended for GCM
const TAG_BYTES = 16  // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Encrypts a credentials object to a storable string.
 * Returns "<ivHex>:<authTagHex>:<ciphertextBase64>".
 */
export function encryptCredentials(creds: ChannelCredentials): string {
  const iv = randomBytes(IV_BYTES)
  const key = getKey()
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const json = JSON.stringify(creds)
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('base64'),
  ].join(':')
}

/**
 * Decrypts a stored credentials blob.
 * Throws if the blob is malformed or the auth tag does not match (tamper detected).
 */
export function decryptCredentials(blob: string): ChannelCredentials {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid credentials blob format')
  }
  const [ivHex, tagHex, cipherBase64] = parts

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(cipherBase64, 'base64')

  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length')
  if (authTag.length !== TAG_BYTES) throw new Error('Invalid auth tag length')

  const key = getKey()
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8')) as ChannelCredentials
}

/**
 * Constant-time comparison for HMAC signatures and API keys.
 * Prevents timing attacks when comparing secrets.
 */
export function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}
