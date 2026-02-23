import { describe, it, expect } from 'vitest'
import { BuscaQuerySchema, AgenteBodySchema, AgentIntentSchema, ExportQuerySchema } from '@/lib/schemas'

describe('BuscaQuerySchema', () => {
  it('accepts valid filters', () => {
    const result = BuscaQuerySchema.parse({
      uf: 'SP',
      municipio: 'Sao Paulo',
      cnae_principal: '8630-5/04',
      situacao_cadastral: 'ATIVA',
      tem_telefone: 'true',
      tem_email: 'false',
      orderBy: 'razao_social',
      orderDir: 'asc',
      page: '1',
      limit: '20',
    })
    expect(result.uf).toBe('SP')
    expect(result.municipio).toBe('Sao Paulo')
    expect(result.cnae_principal).toBe('8630-5/04')
    expect(result.situacao_cadastral).toBe('ATIVA')
    expect(result.tem_telefone).toBe(true)
    expect(result.tem_email).toBe(false)
    expect(result.limit).toBe(20)
  })

  it('applies defaults when optional fields are omitted', () => {
    const result = BuscaQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.orderBy).toBe('razao_social')
    expect(result.orderDir).toBe('asc')
    expect(result.situacao_cadastral).toBe('ATIVA')
  })

  it('caps limit at 100', () => {
    expect(() => BuscaQuerySchema.parse({ limit: '200' })).toThrow()
  })

  it('rejects negative page numbers', () => {
    expect(() => BuscaQuerySchema.parse({ page: '-1' })).toThrow()
  })

  it('rejects page zero', () => {
    expect(() => BuscaQuerySchema.parse({ page: '0' })).toThrow()
  })

  it('rejects orderBy values not in whitelist', () => {
    expect(() => BuscaQuerySchema.parse({ orderBy: 'email' })).toThrow()
    expect(() => BuscaQuerySchema.parse({ orderBy: '1; DROP TABLE estabelecimentos; --' })).toThrow()
  })

  it('rejects orderDir values not in whitelist', () => {
    expect(() => BuscaQuerySchema.parse({ orderDir: 'UNION SELECT' })).toThrow()
  })

  it('trims leading/trailing whitespace in text fields', () => {
    const result = BuscaQuerySchema.parse({ municipio: '  Sao Paulo  ' })
    expect(result.municipio).toBe('Sao Paulo')
  })

  it('collapses multiple internal spaces', () => {
    const result = BuscaQuerySchema.parse({ municipio: 'Belo   Horizonte' })
    expect(result.municipio).toBe('Belo Horizonte')
  })

  it('rejects uf that is not exactly 2 chars', () => {
    expect(() => BuscaQuerySchema.parse({ uf: 'Sao Paulo' })).toThrow()
    expect(() => BuscaQuerySchema.parse({ uf: 'S' })).toThrow()
  })

  it('converts uf to uppercase', () => {
    const result = BuscaQuerySchema.parse({ uf: 'sp' })
    expect(result.uf).toBe('SP')
  })

  it('rejects municipio over 150 characters', () => {
    expect(() => BuscaQuerySchema.parse({ municipio: 'a'.repeat(151) })).toThrow()
  })

  it('rejects invalid situacao_cadastral', () => {
    expect(() => BuscaQuerySchema.parse({ situacao_cadastral: 'ATIVA_SPECIAL' })).toThrow()
  })

  it('accepts all valid situacao_cadastral values', () => {
    for (const val of ['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA']) {
      expect(() => BuscaQuerySchema.parse({ situacao_cadastral: val })).not.toThrow()
    }
  })
})

describe('AgenteBodySchema', () => {
  it('accepts a valid message', () => {
    const result = AgenteBodySchema.parse({ message: 'Clinicas em Sao Paulo' })
    expect(result.message).toBe('Clinicas em Sao Paulo')
  })

  it('rejects message over 1000 characters', () => {
    expect(() => AgenteBodySchema.parse({ message: 'a'.repeat(1001) })).toThrow()
  })

  it('accepts message of exactly 1000 characters', () => {
    expect(() => AgenteBodySchema.parse({ message: 'a'.repeat(1000) })).not.toThrow()
  })

  it('trims leading/trailing whitespace', () => {
    const result = AgenteBodySchema.parse({ message: '  Clinicas em SP  ' })
    expect(result.message).toBe('Clinicas em SP')
  })

  it('rejects missing message field', () => {
    expect(() => AgenteBodySchema.parse({})).toThrow()
  })
})

describe('AgentIntentSchema', () => {
  it('accepts a valid search intent with CNPJ filters', () => {
    const result = AgentIntentSchema.parse({
      action: 'search',
      filters: { uf: 'SP', cnae_principal: '8630-5/04' },
      confidence: 0.9,
    })
    expect(result.action).toBe('search')
    expect(result.confidence).toBe(0.9)
  })

  it('rejects invalid action values', () => {
    expect(() =>
      AgentIntentSchema.parse({ action: 'delete', confidence: 0.5 })
    ).toThrow()
  })

  it('rejects confidence outside 0-1', () => {
    expect(() =>
      AgentIntentSchema.parse({ action: 'search', confidence: 1.5 })
    ).toThrow()
    expect(() =>
      AgentIntentSchema.parse({ action: 'search', confidence: -0.1 })
    ).toThrow()
  })

  it('accepts partial filters', () => {
    const result = AgentIntentSchema.parse({
      action: 'search',
      filters: { municipio: 'Curitiba' },
      confidence: 0.85,
    })
    expect(result.filters?.municipio).toBe('Curitiba')
    expect(result.filters?.uf).toBeUndefined()
  })

  it('accepts clarify action with message', () => {
    const result = AgentIntentSchema.parse({
      action: 'clarify',
      confidence: 1,
      message: 'Seja mais especifico.',
    })
    expect(result.action).toBe('clarify')
    expect(result.message).toBe('Seja mais especifico.')
  })

  it('rejects missing action field', () => {
    expect(() => AgentIntentSchema.parse({ confidence: 0.5 })).toThrow()
  })

  it('rejects missing confidence field', () => {
    expect(() => AgentIntentSchema.parse({ action: 'search' })).toThrow()
  })
})

describe('ExportQuerySchema', () => {
  it('caps maxRows at 5000', () => {
    expect(() => ExportQuerySchema.parse({ maxRows: '9999' })).toThrow()
  })

  it('accepts maxRows of exactly 5000', () => {
    const result = ExportQuerySchema.parse({ maxRows: '5000' })
    expect(result.maxRows).toBe(5000)
  })

  it('defaults formato to csv', () => {
    const result = ExportQuerySchema.parse({})
    expect(result.formato).toBe('csv')
  })

  it('rejects unknown formato values', () => {
    expect(() => ExportQuerySchema.parse({ formato: 'xml' })).toThrow()
  })

  it('accepts CNPJ domain filters', () => {
    const result = ExportQuerySchema.parse({
      uf: 'MG',
      cnae_principal: '9313-1/00',
      situacao_cadastral: 'ATIVA',
      tem_telefone: 'true',
    })
    expect(result.uf).toBe('MG')
    expect(result.cnae_principal).toBe('9313-1/00')
    expect(result.tem_telefone).toBe(true)
  })
})
