import { describe, it, expect } from 'vitest'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { BuscaQuerySchema } from '@/lib/schemas'
import type { BuscaQuery } from '@/lib/schemas'

const baseFilters: BuscaQuery = {
  page: 1,
  limit: 20,
  orderBy: 'razao_social',
  orderDir: 'asc',
  situacao_cadastral: '02',
}

describe('buildContactsQuery', () => {
  it('targets the cnpj_completo table', () => {
    const { text } = buildContactsQuery(baseFilters)
    expect(text).toContain('cnpj_completo')
    expect(text).not.toContain('contacts')
  })

  it('selects CNPJ registry columns with ddd aliases', () => {
    const { text } = buildContactsQuery(baseFilters)
    expect(text).toContain('cnpj_completo')
    expect(text).toContain('razao_social')
    expect(text).toMatch(/ddd1::text\s+AS\s+telefone1/i)
    expect(text).toMatch(/ddd2::text\s+AS\s+telefone2/i)
    expect(text).toContain('correio_eletronico')
    // raw ddd1/ddd2 must not appear un-aliased
    expect(text).not.toMatch(/,\s*ddd1\s*,/)
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

  it('normalizes CNAE via regexp_replace so dashes and slashes are ignored', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, cnae_principal: '8630-5/04' })
    // Both sides stripped of non-digits — '8630-5/04' and '8630504' match the same record
    expect(text).toMatch(/regexp_replace\(cnae_principal/i)
    expect(text).toMatch(/regexp_replace\(\$\d+::text/i)
    // Raw user value is still parameterized (never interpolated into SQL text)
    expect(values).toContain('8630-5/04')
    expect(text).not.toContain('8630-5/04')
  })

  it('filters tem_telefone using the boolean column', () => {
    const { text: tTrue } = buildContactsQuery({ ...baseFilters, tem_telefone: true })
    expect(tTrue).toMatch(/tem_telefone\s*=\s*true/i)

    const { text: tFalse } = buildContactsQuery({ ...baseFilters, tem_telefone: false })
    expect(tFalse).toMatch(/tem_telefone\s*=\s*false/i)
  })

  it('filters tem_email using the boolean column', () => {
    const { text: tTrue } = buildContactsQuery({ ...baseFilters, tem_email: true })
    expect(tTrue).toMatch(/tem_email\s*=\s*true/i)

    const { text: tFalse } = buildContactsQuery({ ...baseFilters, tem_email: false })
    expect(tFalse).toMatch(/tem_email\s*=\s*false/i)
  })

  it('numbers placeholders correctly with multiple string filters', () => {
    const { text, values } = buildContactsQuery({
      ...baseFilters,
      uf: 'SP',
      municipio: 'Campinas',
      cnae_principal: '8630-5/04',
    })
    expect(text).toContain('$1') // uf
    expect(text).toContain('$2') // municipio wildcard
    expect(text).toContain('$3') // cnae_principal (raw value, normalized in SQL)
    expect(text).toContain('$4') // situacao_cadastral from baseFilters
    // uf + municipio + cnae_principal + situacao_cadastral + LIMIT + OFFSET = 6 params
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

  it('appends cnpj_completo ASC as stable tiebreaker in all ORDER BY clauses', () => {
    // Generic ordering (e.g. municipio desc) — tiebreaker must follow
    const { text: textGeneric } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'municipio',
      orderDir: 'desc',
    })
    expect(textGeneric).toMatch(/municipio desc,\s*cnpj_completo ASC/i)

    // contato_priority CASE expression — tiebreaker must also be present
    const { text: textPriority } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'contato_priority',
      orderDir: 'asc',
    })
    expect(textPriority).toMatch(/cnpj_completo ASC/i)
  })

  it('does not allow arbitrary strings in ORDER BY (schema prevents this)', () => {
    expect(() =>
      BuscaQuerySchema.parse({ orderBy: '1; SELECT pg_sleep(5); --' })
    ).toThrow()
  })
})

describe('buildCountQuery', () => {
  it('returns a COUNT query targeting cnpj_completo', () => {
    const { text } = buildCountQuery({})
    expect(text).toMatch(/COUNT\(\*\)/i)
    expect(text).toContain('cnpj_completo')
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
