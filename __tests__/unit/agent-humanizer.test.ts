import { describe, it, expect } from 'vitest'
import {
  humanizeSearchResult,
  applyMessageTemplate,
  normalizePhoneForWhatsApp,
  FIRST_CONTACT_TEMPLATES,
} from '@/lib/agent-humanizer'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEmpresa(overrides: Partial<PublicEmpresa> = {}): PublicEmpresa {
  return {
    cnpj: '11222333000181',
    razaoSocial: 'CLINICA ODONTO LTDA',
    nomeFantasia: 'Odonto SP',
    uf: 'SP',
    municipio: 'SAO PAULO',
    cnaePrincipal: '8630-5/04',
    situacao: 'ATIVA',
    telefone1: '11999990000',
    telefone2: '',
    email: 'contato@odonto.com',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// humanizeSearchResult
// ---------------------------------------------------------------------------

describe('humanizeSearchResult', () => {
  it('returns zero headline when total is 0', () => {
    const { headline } = humanizeSearchResult({
      total: 0,
      count: 0,
      filters: { nicho: 'dentistas' },
      data: [],
    })
    expect(headline).toContain('Nenhuma empresa')
    expect(headline).toContain('dentistas')
  })

  it('uses singular for 1 result', () => {
    const { headline } = humanizeSearchResult({
      total: 1,
      count: 1,
      filters: { nicho: 'academias' },
      data: [makeEmpresa()],
    })
    expect(headline).toMatch(/^1 empresa/)
  })

  it('formats large numbers with pt-BR locale', () => {
    const { headline } = humanizeSearchResult({
      total: 1234,
      count: 20,
      filters: { uf: 'SP' },
      data: Array.from({ length: 20 }, () => makeEmpresa()),
    })
    // 1.234 in pt-BR
    expect(headline).toContain('1.234')
  })

  it('includes city and state in headline', () => {
    const { headline } = humanizeSearchResult({
      total: 5,
      count: 5,
      filters: { municipio: 'Manaus', uf: 'AM', nicho: 'saloes' },
      data: [makeEmpresa()],
    })
    expect(headline).toContain('Manaus/AM')
  })

  it('includes state only when no city', () => {
    const { headline } = humanizeSearchResult({
      total: 5,
      count: 5,
      filters: { uf: 'RJ', nicho: 'restaurantes' },
      data: [makeEmpresa()],
    })
    expect(headline).toContain('em RJ')
  })

  it('notes telefone filter in headline', () => {
    const { headline } = humanizeSearchResult({
      total: 10,
      count: 5,
      filters: { tem_telefone: true },
      data: [makeEmpresa()],
    })
    expect(headline).toContain('com telefone')
  })

  it('notes both telefone and email in headline', () => {
    const { headline } = humanizeSearchResult({
      total: 5,
      count: 5,
      filters: { tem_telefone: true, tem_email: true },
      data: [makeEmpresa()],
    })
    expect(headline).toContain('telefone e e-mail')
  })

  it('subtitle shows count vs total when partial', () => {
    const { subtitle } = humanizeSearchResult({
      total: 100,
      count: 20,
      filters: {},
      data: Array.from({ length: 20 }, () => makeEmpresa()),
    })
    expect(subtitle).toContain('Mostrando 20 de 100')
  })

  it('subtitle says "todas" when all returned', () => {
    const { subtitle } = humanizeSearchResult({
      total: 3,
      count: 3,
      filters: {},
      data: [makeEmpresa(), makeEmpresa(), makeEmpresa()],
    })
    expect(subtitle).toContain('Mostrando todas')
  })

  it('hasCta is true when at least one result has telefone1', () => {
    const { hasCta } = humanizeSearchResult({
      total: 2,
      count: 2,
      filters: {},
      data: [makeEmpresa({ telefone1: '11999990000' }), makeEmpresa({ telefone1: '' })],
    })
    expect(hasCta).toBe(true)
  })

  it('hasCta is false when no results have telefone1', () => {
    const { hasCta } = humanizeSearchResult({
      total: 2,
      count: 2,
      filters: {},
      data: [makeEmpresa({ telefone1: '' }), makeEmpresa({ telefone1: '' })],
    })
    expect(hasCta).toBe(false)
  })

  it('hasCta is false when total is 0', () => {
    const { hasCta } = humanizeSearchResult({
      total: 0,
      count: 0,
      filters: {},
      data: [],
    })
    expect(hasCta).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyMessageTemplate
// ---------------------------------------------------------------------------

describe('applyMessageTemplate', () => {
  it('replaces [Nome] with first word of razaoSocial', () => {
    const result = applyMessageTemplate('Oi, [Nome]!', { razaoSocial: 'Joao Silva' })
    expect(result).toBe('Oi, Joao!')
  })

  it('prefers nomeFantasia over razaoSocial for [Nome]', () => {
    const result = applyMessageTemplate('Oi, [Nome]!', {
      razaoSocial: 'EMPRESA LTDA',
      nomeFantasia: 'Mercado Bom',
    })
    expect(result).toBe('Oi, Mercado!')
  })

  it('replaces [Empresa] with nomeFantasia when present', () => {
    const result = applyMessageTemplate('A [Empresa] pode se beneficiar', {
      nomeFantasia: 'Odonto SP',
      razaoSocial: 'CLINICA LTDA',
    })
    expect(result).toBe('A Odonto SP pode se beneficiar')
  })

  it('falls back to razaoSocial for [Empresa] when nomeFantasia absent', () => {
    const result = applyMessageTemplate('A [Empresa] pode', { razaoSocial: 'CLINICA LTDA' })
    expect(result).toBe('A CLINICA LTDA pode')
  })

  it('replaces [segmento] with nicho', () => {
    const result = applyMessageTemplate('[segmento]', { nicho: 'dentistas' })
    expect(result).toBe('dentistas')
  })

  it('falls back to "seu segmento" when no nicho or cnae', () => {
    const result = applyMessageTemplate('[segmento]', {})
    expect(result).toBe('seu segmento')
  })

  it('replaces [cidade] with municipio', () => {
    const result = applyMessageTemplate('[cidade]', { municipio: 'Manaus' })
    expect(result).toBe('Manaus')
  })

  it('falls back to "sua cidade" when municipio absent', () => {
    const result = applyMessageTemplate('[cidade]', {})
    expect(result).toBe('sua cidade')
  })

  it('replaces all occurrences of each placeholder', () => {
    const result = applyMessageTemplate('[Nome] e [Nome]', { razaoSocial: 'Paulo' })
    expect(result).toBe('Paulo e Paulo')
  })

  it('handles template with all placeholders', () => {
    const tpl = FIRST_CONTACT_TEMPLATES[0].body
    const result = applyMessageTemplate(tpl, {
      razaoSocial: 'Consultorio Dentes',
      nomeFantasia: 'Dentes SP',
      municipio: 'Sao Paulo',
      nicho: 'odontologia',
    })
    expect(result).not.toContain('[Nome]')
    expect(result).not.toContain('[Empresa]')
    expect(result).not.toContain('[segmento]')
    expect(result).not.toContain('[cidade]')
  })
})

// ---------------------------------------------------------------------------
// normalizePhoneForWhatsApp
// ---------------------------------------------------------------------------

describe('normalizePhoneForWhatsApp', () => {
  it('returns null for null input', () => {
    expect(normalizePhoneForWhatsApp(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(normalizePhoneForWhatsApp(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizePhoneForWhatsApp('')).toBeNull()
  })

  it('returns null for number shorter than 8 digits', () => {
    expect(normalizePhoneForWhatsApp('1234567')).toBeNull()
  })

  it('strips non-digit characters', () => {
    const result = normalizePhoneForWhatsApp('+55 (11) 99999-0000')
    expect(result).toBe('5511999990000')
  })

  it('keeps number already in E.164 without + (55 prefix, 13 digits)', () => {
    expect(normalizePhoneForWhatsApp('5511999990000')).toBe('5511999990000')
  })

  it('prepends 55 for 11-digit DDD+number', () => {
    expect(normalizePhoneForWhatsApp('11999990000')).toBe('5511999990000')
  })

  it('prepends 55 for 10-digit DDD+landline', () => {
    expect(normalizePhoneForWhatsApp('1133330000')).toBe('551133330000')
  })

  it('strips leading 0 before prepending 55', () => {
    expect(normalizePhoneForWhatsApp('011999990000')).toBe('5511999990000')
  })

  it('returns null for number with only separators', () => {
    expect(normalizePhoneForWhatsApp('---')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FIRST_CONTACT_TEMPLATES
// ---------------------------------------------------------------------------

describe('FIRST_CONTACT_TEMPLATES', () => {
  it('has exactly 3 templates', () => {
    expect(FIRST_CONTACT_TEMPLATES).toHaveLength(3)
  })

  it('each template has a unique id', () => {
    const ids = FIRST_CONTACT_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('each template body contains at least one placeholder', () => {
    const placeholders = /\[(Nome|Empresa|segmento|cidade)\]/
    for (const t of FIRST_CONTACT_TEMPLATES) {
      expect(placeholders.test(t.body)).toBe(true)
    }
  })
})
