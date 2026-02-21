import { describe, it, expect } from 'vitest'
import {
  CreateCampaignSchema,
  ConfirmCampaignSchema,
  SelectChannelSchema,
  SetCampaignMessageSchema,
  RecipientPaginationSchema,
  CAMPAIGN_STATUSES,
} from '@/lib/schemas'

// ---------------------------------------------------------------------------
// Campaign schema unit tests
// ---------------------------------------------------------------------------

const validRecipient = {
  cnpj: '11222333000181',
  razao_social: 'CLINICA ODONTO LTDA',
  nome_fantasia: 'Odonto SP',
  telefone: '11999990000',
  email: 'contato@odonto.com',
  municipio: 'SAO PAULO',
  uf: 'sp', // lowercase → should be coerced to SP
}

// ---------------------------------------------------------------------------
// CreateCampaignSchema
// ---------------------------------------------------------------------------

describe('CreateCampaignSchema', () => {
  it('accepts valid minimal payload', () => {
    const result = CreateCampaignSchema.parse({
      recipients: [{ cnpj: '11222333000181', razao_social: 'EMPRESA LTDA' }],
    })
    expect(result.recipients).toHaveLength(1)
  })

  it('accepts full payload', () => {
    const result = CreateCampaignSchema.parse({
      name: 'Campanha Teste',
      search_filters: { uf: 'SP', nicho: 'dentistas' },
      recipients: [validRecipient],
    })
    expect(result.name).toBe('Campanha Teste')
    expect(result.recipients[0].uf).toBe('SP') // coerced to upper
  })

  it('rejects empty recipients array', () => {
    expect(() => CreateCampaignSchema.parse({ recipients: [] })).toThrow()
  })

  it('rejects more than 500 recipients', () => {
    const recipients = Array.from({ length: 501 }, () => ({
      cnpj: '11222333000181',
      razao_social: 'EMPRESA',
    }))
    expect(() => CreateCampaignSchema.parse({ recipients })).toThrow()
  })

  it('accepts exactly 500 recipients', () => {
    const recipients = Array.from({ length: 500 }, (_, i) => ({
      cnpj: String(i).padStart(14, '0'),
      razao_social: 'EMPRESA',
    }))
    const result = CreateCampaignSchema.parse({ recipients })
    expect(result.recipients).toHaveLength(500)
  })

  it('trims whitespace from razao_social', () => {
    const result = CreateCampaignSchema.parse({
      recipients: [{ cnpj: '11222333000181', razao_social: '  EMPRESA  ' }],
    })
    expect(result.recipients[0].razao_social).toBe('EMPRESA')
  })

  it('coerces uf to uppercase', () => {
    const result = CreateCampaignSchema.parse({
      recipients: [{ cnpj: '11222333000181', razao_social: 'A', uf: 'sp' }],
    })
    expect(result.recipients[0].uf).toBe('SP')
  })

  it('rejects cnpj longer than 20 chars', () => {
    expect(() =>
      CreateCampaignSchema.parse({
        recipients: [{ cnpj: 'x'.repeat(21), razao_social: 'A' }],
      }),
    ).toThrow()
  })

  it('rejects razao_social longer than 200 chars', () => {
    expect(() =>
      CreateCampaignSchema.parse({
        recipients: [{ cnpj: '1', razao_social: 'x'.repeat(201) }],
      }),
    ).toThrow()
  })

  it('rejects name longer than 200 chars', () => {
    expect(() =>
      CreateCampaignSchema.parse({
        name: 'x'.repeat(201),
        recipients: [{ cnpj: '1', razao_social: 'A' }],
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// ConfirmCampaignSchema
// ---------------------------------------------------------------------------

describe('ConfirmCampaignSchema', () => {
  it('accepts a 64-char hex token', () => {
    const token = 'a'.repeat(64)
    const result = ConfirmCampaignSchema.parse({ confirmation_token: token })
    expect(result.confirmation_token).toBe(token)
  })

  it('rejects token shorter than 32 chars', () => {
    expect(() =>
      ConfirmCampaignSchema.parse({ confirmation_token: 'x'.repeat(31) }),
    ).toThrow()
  })

  it('rejects token longer than 128 chars', () => {
    expect(() =>
      ConfirmCampaignSchema.parse({ confirmation_token: 'x'.repeat(129) }),
    ).toThrow()
  })

  it('rejects missing confirmation_token', () => {
    expect(() => ConfirmCampaignSchema.parse({})).toThrow()
  })
})

// ---------------------------------------------------------------------------
// SelectChannelSchema
// ---------------------------------------------------------------------------

describe('SelectChannelSchema', () => {
  it('accepts a valid UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const result = SelectChannelSchema.parse({ channel_id: uuid })
    expect(result.channel_id).toBe(uuid)
  })

  it('rejects non-UUID channel_id', () => {
    expect(() => SelectChannelSchema.parse({ channel_id: 'not-a-uuid' })).toThrow()
  })

  it('rejects missing channel_id', () => {
    expect(() => SelectChannelSchema.parse({})).toThrow()
  })
})

// ---------------------------------------------------------------------------
// SetCampaignMessageSchema
// ---------------------------------------------------------------------------

describe('SetCampaignMessageSchema', () => {
  it('accepts valid template message', () => {
    const result = SetCampaignMessageSchema.parse({
      message_type: 'template',
      message_content: {
        type: 'template',
        name: 'primeiro_contato_v1',
        language: 'pt_BR',
        body_params: ['param1'],
      },
    })
    expect(result.message_type).toBe('template')
  })

  it('accepts valid text message', () => {
    const result = SetCampaignMessageSchema.parse({
      message_type: 'text',
      message_content: { type: 'text', body: 'Olá, [Nome]!' },
    })
    expect(result.message_type).toBe('text')
  })

  it('rejects invalid message_type', () => {
    expect(() =>
      SetCampaignMessageSchema.parse({
        message_type: 'audio',
        message_content: { type: 'text', body: 'hi' },
      }),
    ).toThrow()
  })

  it('rejects invalid language format', () => {
    expect(() =>
      SetCampaignMessageSchema.parse({
        message_type: 'template',
        message_content: {
          type: 'template',
          name: 'test',
          language: 'portuguese', // invalid format
        },
      }),
    ).toThrow()
  })

  it('accepts pt_BR language', () => {
    const result = SetCampaignMessageSchema.parse({
      message_type: 'template',
      message_content: { type: 'template', name: 'test', language: 'pt_BR' },
    })
    expect(result.message_content).toMatchObject({ language: 'pt_BR' })
  })

  it('rejects template name longer than 120 chars', () => {
    expect(() =>
      SetCampaignMessageSchema.parse({
        message_type: 'template',
        message_content: {
          type: 'template',
          name: 'x'.repeat(121),
          language: 'pt_BR',
        },
      }),
    ).toThrow()
  })

  it('rejects text body longer than 4096 chars', () => {
    expect(() =>
      SetCampaignMessageSchema.parse({
        message_type: 'text',
        message_content: { type: 'text', body: 'x'.repeat(4097) },
      }),
    ).toThrow()
  })

  it('rejects more than 10 body_params', () => {
    expect(() =>
      SetCampaignMessageSchema.parse({
        message_type: 'template',
        message_content: {
          type: 'template',
          name: 'tmpl',
          language: 'pt_BR',
          body_params: Array.from({ length: 11 }, () => 'x'),
        },
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// RecipientPaginationSchema
// ---------------------------------------------------------------------------

describe('RecipientPaginationSchema', () => {
  it('defaults limit=50 and offset=0', () => {
    const result = RecipientPaginationSchema.parse({})
    expect(result.limit).toBe(50)
    expect(result.offset).toBe(0)
  })

  it('accepts valid status filter', () => {
    const result = RecipientPaginationSchema.parse({ status: 'sent' })
    expect(result.status).toBe('sent')
  })

  it('accepts processing status filter', () => {
    // processing is a live operational status — must be observable via the API
    // during concurrent sends (migration 009/010).
    const result = RecipientPaginationSchema.parse({ status: 'processing' })
    expect(result.status).toBe('processing')
  })

  it('rejects invalid status', () => {
    expect(() => RecipientPaginationSchema.parse({ status: 'unknown' })).toThrow()
  })

  it('rejects limit greater than 100', () => {
    expect(() => RecipientPaginationSchema.parse({ limit: 101 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// CAMPAIGN_STATUSES
// ---------------------------------------------------------------------------

describe('CAMPAIGN_STATUSES', () => {
  it('contains all 10 expected statuses (including paused)', () => {
    expect(CAMPAIGN_STATUSES).toHaveLength(10)
    expect(CAMPAIGN_STATUSES).toContain('draft')
    expect(CAMPAIGN_STATUSES).toContain('awaiting_confirmation')
    expect(CAMPAIGN_STATUSES).toContain('awaiting_channel')
    expect(CAMPAIGN_STATUSES).toContain('awaiting_message')
    expect(CAMPAIGN_STATUSES).toContain('ready_to_send')
    expect(CAMPAIGN_STATUSES).toContain('sending')
    expect(CAMPAIGN_STATUSES).toContain('paused')
    expect(CAMPAIGN_STATUSES).toContain('completed')
    expect(CAMPAIGN_STATUSES).toContain('completed_with_errors')
    expect(CAMPAIGN_STATUSES).toContain('cancelled')
  })
})
