// ---------------------------------------------------------------------------
// Unit tests — SendReactionSchema
//
// Verifies that target_provider_message_id accepts real provider message IDs
// (wamid.xxx, Evolution arbitrary strings, UAZAPI IDs) and rejects bad input.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { SendReactionSchema } from '@/lib/schemas'

describe('SendReactionSchema — target_provider_message_id', () => {
  const base = { to: '5511999990001', emoji: '👍' }

  // ---- Valid provider IDs -------------------------------------------------

  it('accepts a Meta wamid identifier', () => {
    const result = SendReactionSchema.parse({
      ...base,
      target_provider_message_id: 'wamid.HBgLNTUxMTk5OTk5MDAwMBIAEhgIM0FBQUE',
    })
    expect(result.target_provider_message_id).toBe('wamid.HBgLNTUxMTk5OTk5MDAwMBIAEhgIM0FBQUE')
  })

  it('accepts an Evolution message key (arbitrary alphanumeric string)', () => {
    const result = SendReactionSchema.parse({
      ...base,
      target_provider_message_id: 'BAE5F4B2A8DC1234',
    })
    expect(result.target_provider_message_id).toBe('BAE5F4B2A8DC1234')
  })

  it('accepts a UAZAPI message ID (numeric string)', () => {
    const result = SendReactionSchema.parse({
      ...base,
      target_provider_message_id: '3EB0F2C4D1E5A678',
    })
    expect(result.target_provider_message_id).toBe('3EB0F2C4D1E5A678')
  })

  it('accepts a UUID-format string (backward compat)', () => {
    const result = SendReactionSchema.parse({
      ...base,
      target_provider_message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    expect(result.target_provider_message_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('accepts an ID at exactly 200 characters (max length)', () => {
    const longId = 'x'.repeat(200)
    const result = SendReactionSchema.parse({ ...base, target_provider_message_id: longId })
    expect(result.target_provider_message_id).toHaveLength(200)
  })

  // ---- Invalid inputs -----------------------------------------------------

  it('rejects when target_provider_message_id is absent', () => {
    expect(() => SendReactionSchema.parse({ ...base })).toThrow()
  })

  it('rejects a string shorter than 8 characters', () => {
    expect(() =>
      SendReactionSchema.parse({ ...base, target_provider_message_id: 'short' }),
    ).toThrow()
  })

  it('rejects a string longer than 200 characters', () => {
    expect(() =>
      SendReactionSchema.parse({ ...base, target_provider_message_id: 'x'.repeat(201) }),
    ).toThrow()
  })

  // ---- Other fields still validated ---------------------------------------

  it('rejects invalid phone number (letters)', () => {
    expect(() =>
      SendReactionSchema.parse({
        to: 'invalid-phone',
        emoji: '👍',
        target_provider_message_id: 'wamid.HBgLNTUxMTk5OTk5',
      }),
    ).toThrow()
  })

  it('rejects empty emoji', () => {
    expect(() =>
      SendReactionSchema.parse({
        ...base,
        emoji: '',
        target_provider_message_id: 'wamid.HBgLNTUxMTk5OTk5',
      }),
    ).toThrow()
  })
})
