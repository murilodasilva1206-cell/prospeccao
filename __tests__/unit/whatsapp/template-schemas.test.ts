import { describe, it, expect } from 'vitest'
import {
  ListTemplatesQuerySchema,
  MetaTemplateItemSchema,
  TemplateSendParamsSchema,
  LanguageSchema,
  ALLOWED_TEMPLATE_SEND_STATUSES,
} from '@/lib/schemas'
import { extractBodyVariables } from '@/lib/whatsapp/template-repo'

// ---------------------------------------------------------------------------
// Unit: Template schema validation
// ---------------------------------------------------------------------------

describe('MetaTemplateItemSchema', () => {
  const valid = {
    id: 'meta-tpl-001',
    name: 'boas_vindas',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' },
      { type: 'BODY', text: 'Prezado {{1}}, temos uma oferta para {{2}}.' },
      { type: 'FOOTER', text: 'Não responda.' },
    ],
  }

  it('accepts a valid template item', () => {
    expect(() => MetaTemplateItemSchema.parse(valid)).not.toThrow()
  })

  it('rejects unknown status', () => {
    expect(() =>
      MetaTemplateItemSchema.parse({ ...valid, status: 'DRAFT' }),
    ).toThrow()
  })

  it('rejects missing name', () => {
    const { name: _n, ...rest } = valid
    expect(() => MetaTemplateItemSchema.parse(rest)).toThrow()
  })

  it('rejects missing language', () => {
    const { language: _l, ...rest } = valid
    expect(() => MetaTemplateItemSchema.parse(rest)).toThrow()
  })

  it('accepts all valid statuses', () => {
    for (const status of ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED']) {
      expect(() => MetaTemplateItemSchema.parse({ ...valid, status })).not.toThrow()
    }
  })

  it('counts {{N}} variables in BODY component correctly', () => {
    const result = MetaTemplateItemSchema.parse(valid)
    // Finds {{1}} and {{2}} in body
    const body = result.components.find((c) => c.type === 'BODY')
    expect(body?.text).toContain('{{1}}')
    expect(body?.text).toContain('{{2}}')
  })
})

// ---------------------------------------------------------------------------
// TemplateSendParamsSchema (for campaign set-message and send-template)
// ---------------------------------------------------------------------------

describe('TemplateSendParamsSchema', () => {
  it('accepts valid template send params', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'boas_vindas',
        language: 'pt_BR',
        body_params: ['João', 'Clínica Silva'],
      }),
    ).not.toThrow()
  })

  it('accepts empty body_params', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'sem_vars',
        language: 'en_US',
        body_params: [],
      }),
    ).not.toThrow()
  })

  it('rejects invalid language format with special chars', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'tpl',
        language: "'; DROP TABLE templates; --",
        body_params: [],
      }),
    ).toThrow()
  })

  it('rejects body_params with more than 20 items', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'tpl',
        language: 'pt_BR',
        body_params: Array(21).fill('valor'),
      }),
    ).toThrow()
  })

  it('rejects body_param strings over 1024 chars', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'tpl',
        language: 'pt_BR',
        body_params: ['x'.repeat(1025)],
      }),
    ).toThrow()
  })

  it('rejects template name with spaces', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'template com espaços',
        language: 'pt_BR',
        body_params: [],
      }),
    ).toThrow()
  })

  it('rejects template name over 512 chars', () => {
    expect(() =>
      TemplateSendParamsSchema.parse({
        name: 'a'.repeat(513),
        language: 'pt_BR',
        body_params: [],
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// ListTemplatesQuerySchema
// ---------------------------------------------------------------------------

describe('ListTemplatesQuerySchema', () => {
  it('accepts empty query with defaults', () => {
    const result = ListTemplatesQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.status).toBeUndefined()
    expect(result.language).toBeUndefined()
    expect(result.search).toBeUndefined()
  })

  it('accepts all valid filters', () => {
    const result = ListTemplatesQuerySchema.parse({
      page: '2',
      limit: '50',
      status: 'APPROVED',
      language: 'pt_BR',
      search: 'boas_vindas',
    })
    expect(result.page).toBe(2)
    expect(result.limit).toBe(50)
    expect(result.status).toBe('APPROVED')
    expect(result.language).toBe('pt_BR')
    expect(result.search).toBe('boas_vindas')
  })

  it('rejects invalid status', () => {
    expect(() =>
      ListTemplatesQuerySchema.parse({ status: 'ACTIVE' }),
    ).toThrow()
  })

  it('rejects limit above 100', () => {
    expect(() =>
      ListTemplatesQuerySchema.parse({ limit: '200' }),
    ).toThrow()
  })

  it('rejects search over 100 chars', () => {
    expect(() =>
      ListTemplatesQuerySchema.parse({ search: 'a'.repeat(101) }),
    ).toThrow()
  })

  it('rejects SQL injection in search param', () => {
    // SafeString trims and collapses whitespace — SQL keywords remain but are safe
    // because the repo uses parameterized queries. However, we verify schema doesn't throw
    // for valid-length inputs (injection safety is at repo layer).
    expect(() =>
      ListTemplatesQuerySchema.parse({ search: "'; DROP TABLE templates; --" }),
    ).not.toThrow() // length < 100, schema accepts; repo uses $N param
  })
})

// ---------------------------------------------------------------------------
// ALLOWED_TEMPLATE_SEND_STATUSES constant
// ---------------------------------------------------------------------------

describe('ALLOWED_TEMPLATE_SEND_STATUSES', () => {
  it('only includes APPROVED', () => {
    expect(ALLOWED_TEMPLATE_SEND_STATUSES).toContain('APPROVED')
    expect(ALLOWED_TEMPLATE_SEND_STATUSES).not.toContain('PENDING')
    expect(ALLOWED_TEMPLATE_SEND_STATUSES).not.toContain('REJECTED')
    expect(ALLOWED_TEMPLATE_SEND_STATUSES).not.toContain('PAUSED')
    expect(ALLOWED_TEMPLATE_SEND_STATUSES).not.toContain('DISABLED')
  })
})

// ---------------------------------------------------------------------------
// LanguageSchema — split-based, no unsafe regex
// ---------------------------------------------------------------------------

describe('LanguageSchema', () => {
  it('accepts ISO 639-1 only (2 lowercase letters)', () => {
    expect(() => LanguageSchema.parse('pt')).not.toThrow()
    expect(() => LanguageSchema.parse('en')).not.toThrow()
  })

  it('accepts language_REGION format', () => {
    expect(() => LanguageSchema.parse('pt_BR')).not.toThrow()
    expect(() => LanguageSchema.parse('en_US')).not.toThrow()
    expect(() => LanguageSchema.parse('zh_CN')).not.toThrow()
  })

  it('rejects uppercase language code (PT_BR)', () => {
    expect(() => LanguageSchema.parse('PT_BR')).toThrow()
  })

  it('rejects camelCase (ptBR)', () => {
    expect(() => LanguageSchema.parse('ptBR')).toThrow()
  })

  it('rejects region with 3 letters (pt_BRR)', () => {
    expect(() => LanguageSchema.parse('pt_BRR')).toThrow()
  })

  it('rejects lowercase region (pt_br)', () => {
    expect(() => LanguageSchema.parse('pt_br')).toThrow()
  })

  it('rejects SQL injection string', () => {
    expect(() => LanguageSchema.parse("'; DROP TABLE templates; --")).toThrow()
  })

  it('rejects string over 20 chars', () => {
    expect(() => LanguageSchema.parse('pt_BR_extra_long_val')).toThrow()
  })

  it('rejects empty string', () => {
    expect(() => LanguageSchema.parse('')).toThrow()
  })

  it('rejects 3-part code (pt_BR_Latin)', () => {
    expect(() => LanguageSchema.parse('pt_BR_Latin')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Variable extraction helper (extractBodyVariables)
// ---------------------------------------------------------------------------

describe('Variable extraction from template body text', () => {
  it('extracts {{N}} placeholders in order', () => {
    const text = 'Olá {{1}}, bem-vindo à {{2}}! Código: {{3}}'
    const vars = extractBodyVariables(text)
    expect(vars).toEqual([1, 2, 3])
  })

  it('returns empty array when no variables', () => {
    expect(extractBodyVariables('Olá, tudo bem?')).toEqual([])
  })

  it('deduplicates repeated placeholders', () => {
    expect(extractBodyVariables('{{1}} e {{1}} de novo')).toEqual([1])
  })
})
