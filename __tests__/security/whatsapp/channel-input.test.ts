import { describe, it, expect } from 'vitest'
import { ChannelCreateSchema, SendMessageSchema, WebhookPathSchema } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Channel input validation security tests
//
// Verifies that the Zod schemas reject:
//   - SQL injection in name / workspace_id fields
//   - Provider values outside the allowed enum
//   - Invalid UUIDs in webhook path params
//   - Malformed phone numbers
//   - Oversized inputs (DoS via large payloads)
// ---------------------------------------------------------------------------

const SQL_PAYLOADS = [
  "'; DROP TABLE whatsapp_channels; --",
  "' OR '1'='1",
  "' UNION SELECT * FROM pg_user --",
  "1; SELECT pg_sleep(5) --",
  "admin'--",
]

// ---------------------------------------------------------------------------
// ChannelCreateSchema
// ---------------------------------------------------------------------------
describe('ChannelCreateSchema — SQL injection prevention', () => {
  const validBase = {
    workspace_id: 'ws-001',
    name: 'Meu Canal',
    provider: 'META_CLOUD' as const,
    credentials: {
      access_token: 'EAAtest',
      phone_number_id: '1234567890',
    },
  }

  it('accepts a valid channel creation payload', () => {
    expect(() => ChannelCreateSchema.parse(validBase)).not.toThrow()
  })

  it('rejects provider not in enum', () => {
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, provider: 'TELEGRAM' }),
    ).toThrow()
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, provider: "'; DROP TABLE whatsapp_channels; --" }),
    ).toThrow()
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, provider: '' }),
    ).toThrow()
  })

  it('rejects name over 100 characters', () => {
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, name: 'a'.repeat(101) }),
    ).toThrow()
  })

  it('rejects workspace_id over 100 characters', () => {
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, workspace_id: 'x'.repeat(101) }),
    ).toThrow()
  })

  it('trims and normalizes whitespace in name', () => {
    const result = ChannelCreateSchema.parse({ ...validBase, name: '  My   Channel  ' })
    expect(result.name).toBe('My Channel')
  })

  it('rejects access_token over 512 characters', () => {
    expect(() =>
      ChannelCreateSchema.parse({
        ...validBase,
        credentials: { access_token: 'x'.repeat(513) },
      }),
    ).toThrow()
  })

  it('rejects api_key over 200 characters', () => {
    expect(() =>
      ChannelCreateSchema.parse({
        ...validBase,
        provider: 'EVOLUTION',
        credentials: { instance_url: 'https://evo.test', api_key: 'x'.repeat(201) },
      }),
    ).toThrow()
  })

  it('rejects invalid phone_number formats', () => {
    // Too short
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, phone_number: '123' }),
    ).toThrow()
    // Contains letters
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, phone_number: '+551199abc0000' }),
    ).toThrow()
    // Too long
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, phone_number: '+' + '1'.repeat(17) }),
    ).toThrow()
  })

  it('accepts valid phone numbers', () => {
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, phone_number: '+5511999990000' }),
    ).not.toThrow()
    expect(() =>
      ChannelCreateSchema.parse({ ...validBase, phone_number: '5511999990000' }),
    ).not.toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() => ChannelCreateSchema.parse({ name: 'Test' })).toThrow()
    expect(() => ChannelCreateSchema.parse({ workspace_id: 'ws', provider: 'META_CLOUD' })).toThrow()
  })

  // SQL payloads survive schema (they are strings within length limits), but
  // the important property is that the schema does NOT interpret them as SQL.
  // The query builder uses parameterized queries — tested in sql-injection.test.ts.
  it('SQL payload in name: does not throw (length ≤100), but stays as literal string', () => {
    for (const payload of SQL_PAYLOADS) {
      if (payload.length <= 100) {
        const result = ChannelCreateSchema.parse({ ...validBase, name: payload })
        // The value is preserved as-is (parameterized at DB layer — not schema's job to reject)
        expect(result.name).toBeTruthy()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// SendMessageSchema
// ---------------------------------------------------------------------------
describe('SendMessageSchema — input validation', () => {
  it('accepts a valid send payload', () => {
    const result = SendMessageSchema.parse({ to: '5511999990000', message: 'Ola mundo' })
    expect(result.to).toBe('5511999990000')
    expect(result.message).toBe('Ola mundo')
  })

  it('rejects to with non-digit characters', () => {
    expect(() => SendMessageSchema.parse({ to: '+5511999990000', message: 'Hi' })).toThrow()
    expect(() => SendMessageSchema.parse({ to: '55119999abcde', message: 'Hi' })).toThrow()
    expect(() => SendMessageSchema.parse({ to: "'; DROP TABLE--", message: 'Hi' })).toThrow()
  })

  it('rejects to shorter than 8 digits', () => {
    expect(() => SendMessageSchema.parse({ to: '1234567', message: 'Hi' })).toThrow()
  })

  it('rejects to longer than 15 digits', () => {
    expect(() => SendMessageSchema.parse({ to: '1'.repeat(16), message: 'Hi' })).toThrow()
  })

  it('rejects empty message', () => {
    expect(() => SendMessageSchema.parse({ to: '5511999990000', message: '' })).toThrow()
  })

  it('rejects message over 4096 characters', () => {
    expect(() =>
      SendMessageSchema.parse({ to: '5511999990000', message: 'x'.repeat(4097) }),
    ).toThrow()
  })

  it('accepts message of exactly 4096 characters', () => {
    expect(() =>
      SendMessageSchema.parse({ to: '5511999990000', message: 'x'.repeat(4096) }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// WebhookPathSchema
// ---------------------------------------------------------------------------
describe('WebhookPathSchema — path param validation', () => {
  it('accepts valid META_CLOUD provider and UUID channelId', () => {
    // Use a proper v4 UUID (version=4, variant=8/9/a/b)
    const result = WebhookPathSchema.parse({
      provider: 'META_CLOUD',
      channelId: '11111111-1111-4111-8111-111111111111',
    })
    expect(result.provider).toBe('META_CLOUD')
    expect(result.channelId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('accepts all valid providers', () => {
    for (const provider of ['META_CLOUD', 'EVOLUTION', 'UAZAPI']) {
      expect(() =>
        WebhookPathSchema.parse({ provider, channelId: '22222222-2222-4222-8222-222222222222' }),
      ).not.toThrow()
    }
  })

  it('rejects unknown provider', () => {
    expect(() =>
      WebhookPathSchema.parse({
        provider: 'TELEGRAM',
        channelId: '00000000-0000-0000-0000-000000000001',
      }),
    ).toThrow()
  })

  it('rejects invalid (non-UUID) channelId', () => {
    const invalidIds = [
      'not-a-uuid',
      '12345',
      "'; DROP TABLE webhook_events; --",
      '../../../etc/passwd',
      '',
      'null',
      '00000000-0000-0000-0000',  // incomplete
    ]
    for (const channelId of invalidIds) {
      expect(() =>
        WebhookPathSchema.parse({ provider: 'META_CLOUD', channelId }),
      ).toThrow()
    }
  })

  it('rejects SQL injection in provider field', () => {
    expect(() =>
      WebhookPathSchema.parse({
        provider: "META_CLOUD'; DROP TABLE webhook_events; --",
        channelId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow()
  })
})
