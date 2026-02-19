import { describe, it, expect } from 'vitest'
import { encryptCredentials, decryptCredentials, safeCompare } from '@/lib/whatsapp/crypto'
import type { ChannelCredentials } from '@/lib/whatsapp/types'

// CREDENTIALS_ENCRYPTION_KEY is set in vitest.config.ts env block ('a'.repeat(64))

describe('encryptCredentials / decryptCredentials', () => {
  it('roundtrips a full credentials object', () => {
    const creds: ChannelCredentials = {
      access_token: 'tok_abc123',
      phone_number_id: '12345678901',
      waba_id: 'waba_xyz',
      app_secret: 'supersecret',
    }
    const blob = encryptCredentials(creds)
    expect(typeof blob).toBe('string')
    expect(blob.split(':')).toHaveLength(3)

    const recovered = decryptCredentials(blob)
    expect(recovered).toEqual(creds)
  })

  it('roundtrips Evolution/UAZAPI credentials', () => {
    const creds: ChannelCredentials = {
      instance_url: 'https://evo.example.com',
      api_key: 'myapikey',
    }
    const blob = encryptCredentials(creds)
    const recovered = decryptCredentials(blob)
    expect(recovered).toEqual(creds)
  })

  it('roundtrips empty credentials object', () => {
    const creds: ChannelCredentials = {}
    const blob = encryptCredentials(creds)
    const recovered = decryptCredentials(blob)
    expect(recovered).toEqual(creds)
  })

  it('produces different ciphertext for the same input (fresh IV each call)', () => {
    const creds: ChannelCredentials = { api_key: 'same' }
    const blob1 = encryptCredentials(creds)
    const blob2 = encryptCredentials(creds)
    expect(blob1).not.toBe(blob2)
    // But both decrypt correctly
    expect(decryptCredentials(blob1)).toEqual(creds)
    expect(decryptCredentials(blob2)).toEqual(creds)
  })

  it('throws when the auth tag is tampered (bit flip in ciphertext)', () => {
    const blob = encryptCredentials({ api_key: 'value' })
    const [iv, tag, cipher] = blob.split(':')
    // Corrupt the ciphertext: flip the last base64 character
    const flipped = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'B' : 'A') + cipher.slice(-1)
    const tampered = [iv, tag, flipped].join(':')
    expect(() => decryptCredentials(tampered)).toThrow()
  })

  it('throws when the auth tag itself is tampered', () => {
    const blob = encryptCredentials({ api_key: 'value' })
    const [iv, tag, cipher] = blob.split(':')
    const badTag = tag.slice(0, -2) + (tag.endsWith('ff') ? '00' : 'ff')
    expect(() => decryptCredentials([iv, badTag, cipher].join(':'))).toThrow()
  })

  it('throws when blob has wrong number of parts', () => {
    expect(() => decryptCredentials('onlyonepart')).toThrow('Invalid credentials blob format')
    expect(() => decryptCredentials('a:b')).toThrow('Invalid credentials blob format')
    expect(() => decryptCredentials('a:b:c:d')).toThrow('Invalid credentials blob format')
  })

  it('throws when IV length is wrong', () => {
    const [, tag, cipher] = encryptCredentials({ api_key: 'x' }).split(':')
    // Provide a 4-byte IV instead of 12
    expect(() => decryptCredentials(['deadbeef', tag, cipher].join(':'))).toThrow()
  })
})

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('hello', 'hello')).toBe(true)
  })

  it('returns false for different strings of same length', () => {
    expect(safeCompare('hello1', 'hello2')).toBe(false)
  })

  it('returns false for strings of different lengths', () => {
    expect(safeCompare('short', 'muchlonger')).toBe(false)
  })

  it('returns false for empty strings vs non-empty', () => {
    expect(safeCompare('', 'something')).toBe(false)
  })

  it('returns true for empty vs empty', () => {
    expect(safeCompare('', '')).toBe(true)
  })

  it('handles HMAC-like hex strings correctly', () => {
    const sig = 'sha256=abc123def456'
    expect(safeCompare(sig, sig)).toBe(true)
    expect(safeCompare(sig, 'sha256=abc123def457')).toBe(false)
  })
})
