import { describe, it, expect } from 'vitest'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { BuscaQuerySchema } from '@/lib/schemas'
import type { BuscaQuery } from '@/lib/schemas'

const baseFilters: BuscaQuery = {
  page: 1,
  limit: 20,
  orderBy: 'razao_social',
  orderDir: 'asc',
  situacao_cadastral: 'ATIVA',
}

describe('buildContactsQuery', () => {
  it('targets the estabelecimentos table, not contacts', () => {
    const { text } = buildContactsQuery(baseFilters)
    expect(text).toContain('estabelecimentos')
    expect(text).not.toContain('contacts')
  })

  it('selects CNPJ registry columns', () => {
    const { text } = buildContactsQuery(baseFilters)
    expect(text).toContain('cnpj_completo')
    expect(text).toContain('razao_social')
    expect(text).toContain('telefone1')
    expect(text).toContain('correio_eletronico')
  })

  it('uses exact match for uf — no wildcard', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, uf: 'SP' })
    expect(text).toMatch(/uf\s*=\s*\$\d+/i)
    expect(values).toContain('SP')
    expect(values).not.toContain('%SP%')
  })

  it('uses ILIKE with server-side wildcard for municipio', () => {
    const payload = "'; DROP TABLE estabelecimentos; --"
    const { text, values } = buildContactsQuery({ ...baseFilters, municipio: payload })
    expect(text).not.toContain(payload)
    expect(values).toContain(`%${payload}%`)
  })

  it('uses exact match for cnae_principal', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, cnae_principal: '8630-5/04' })
    expect(text).toMatch(/cnae_principal\s*=\s*\$\d+/i)
    expect(values).toContain('8630-5/04')
  })

  it('adds telefone1 IS NOT NULL for tem_telefone=true', () => {
    const { text } = buildContactsQuery({ ...baseFilters, tem_telefone: true })
    expect(text).toMatch(/telefone1\s+IS\s+NOT\s+NULL/i)
  })

  it('adds telefone1 IS NULL for tem_telefone=false', () => {
    const { text } = buildContactsQuery({ ...baseFilters, tem_telefone: false })
    expect(text).toMatch(/telefone1\s+IS\s+NULL/i)
  })

  it('adds correio_eletronico IS NOT NULL for tem_email=true', () => {
    const { text } = buildContactsQuery({ ...baseFilters, tem_email: true })
    expect(text).toMatch(/correio_eletronico\s+IS\s+NOT\s+NULL/i)
  })

  it('numbers placeholders correctly with multiple string filters', () => {
    const { text, values } = buildContactsQuery({
      ...baseFilters,
      uf: 'SP',
      municipio: 'Campinas',
      cnae_principal: '8630-5/04',
    })
    expect(text).toContain('$1')
    expect(text).toContain('$2')
    expect(text).toContain('$3')
    // uf + municipio + cnae_principal + situacao_cadastral + LIMIT + OFFSET = 6 values
    expect(values).toHaveLength(6)
  })

  it('includes LIMIT and OFFSET as parameterized values', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, page: 2, limit: 10 })
    const limitMatch = text.match(/LIMIT\s+\$(\d+)/i)
    const offsetMatch = text.match(/OFFSET\s+\$(\d+)/i)
    expect(limitMatch).toBeTruthy()
    expect(offsetMatch).toBeTruthy()
    const limitIndex = parseInt(limitMatch![1]) - 1
    const offsetIndex = parseInt(offsetMatch![1]) - 1
    expect(values[limitIndex]).toBe(10)
    expect(values[offsetIndex]).toBe(10) // page 2, limit 10 → offset 10
  })

  it('interpolates only enum-validated values for ORDER BY', () => {
    const { text } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'municipio',
      orderDir: 'desc',
    })
    expect(text).toMatch(/ORDER BY municipio desc/i)
  })

  it('does not allow arbitrary strings in ORDER BY (schema prevents this)', () => {
    expect(() =>
      BuscaQuerySchema.parse({ orderBy: '1; SELECT pg_sleep(5); --' })
    ).toThrow()
  })
})

describe('buildCountQuery', () => {
  it('returns a COUNT query targeting estabelecimentos', () => {
    const { text } = buildCountQuery({})
    expect(text).toMatch(/COUNT\(\*\)/i)
    expect(text).toContain('estabelecimentos')
  })

  it('uses parameterized value for uf filter', () => {
    const { text, values } = buildCountQuery({ uf: 'RJ' })
    expect(text).toContain('$1')
    expect(values[0]).toBe('RJ')
  })

  it('uses wildcard parameterized value for municipio', () => {
    const { text, values } = buildCountQuery({ municipio: 'Niteroi' })
    expect(text).toContain('$1')
    expect(values[0]).toBe('%Niteroi%')
  })

  it('does not include LIMIT or OFFSET', () => {
    const { text } = buildCountQuery({ municipio: 'test' })
    expect(text).not.toMatch(/LIMIT/i)
    expect(text).not.toMatch(/OFFSET/i)
  })
})
