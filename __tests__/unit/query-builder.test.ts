import { describe, it, expect } from 'vitest'
import { buildContactsQuery, buildCountQuery, type ExtendedBuscaQuery } from '@/lib/query-builder'
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

  it('uses ILIKE with server-side wildcard for text municipio', () => {
    const payload = "'; DROP TABLE estabelecimentos; --"
    const { text, values } = buildContactsQuery({ ...baseFilters, municipio: payload })
    expect(text).not.toContain(payload)
    expect(values).toContain(`%${payload}%`)
  })

  it('uses exact match for numeric municipio code (resolver output)', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, municipio: '3550308' })
    expect(text).toMatch(/municipio\s*=\s*\$\d+/i)
    expect(values).toContain('3550308')
    expect(values).not.toContain('%3550308%')
  })

  it('uses = ANY for multi-code cnae_codes from nicho resolution', () => {
    const extFilters: ExtendedBuscaQuery = {
      ...baseFilters,
      cnae_codes: ['9602-5/01', '9602-5/02', '9602-5/03'],
    }
    const { text, values } = buildContactsQuery(extFilters)
    expect(text).toContain('regexp_replace(cnae_principal')
    expect(text).toMatch(/=\s*ANY\(/i)
    // Digits are pre-normalised in the app; the array contains digit-only codes
    const codesParam = values.find((v) => Array.isArray(v)) as string[]
    expect(codesParam).toEqual(['9602501', '9602502', '9602503'])
    // ILIKE branch must NOT appear when cnae_codes is set
    expect(text).not.toContain('ILIKE')
  })

  it('falls back to ILIKE for single cnae_principal when cnae_codes not set', () => {
    const { text } = buildContactsQuery({ ...baseFilters, cnae_principal: '8630-5/04' })
    expect(text).toContain('ILIKE')
    expect(text).not.toMatch(/=\s*ANY\(/i)
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

    // contato_priority — tiebreaker must also be present
    const { text: textPriority } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'contato_priority',
      orderDir: 'asc',
    })
    expect(textPriority).toMatch(/cnpj_completo ASC/i)
  })

  it('contato_priority ORDER BY uses boolean DESC columns — not CASE WHEN', () => {
    const { text } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'contato_priority',
      orderDir: 'asc',
    })
    // Index-friendly form
    expect(text).toMatch(/tem_telefone\s+DESC/i)
    expect(text).toMatch(/tem_email\s+DESC/i)
    // Old CASE WHEN form must not appear
    expect(text).not.toMatch(/CASE\s+WHEN/i)
  })

  it('contato_priority ORDER BY preserves razao_social as secondary sort with requested direction', () => {
    const { text: asc } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'contato_priority',
      orderDir: 'asc',
    })
    expect(asc).toMatch(/razao_social\s+asc/i)

    const { text: desc } = buildContactsQuery({
      ...baseFilters,
      orderBy: 'contato_priority',
      orderDir: 'desc',
    })
    expect(desc).toMatch(/razao_social\s+desc/i)
  })

  it('does not allow arbitrary strings in ORDER BY (schema prevents this)', () => {
    expect(() =>
      BuscaQuerySchema.parse({ orderBy: '1; SELECT pg_sleep(5); --' })
    ).toThrow()
  })

  it('single-code nicho via cnae_codes uses = ANY(), not ILIKE', () => {
    // When a nicho resolves to exactly one CNAE the route still puts it in
    // cnae_codes (not cnae_principal) so we always get exact-match semantics.
    const extFilters: ExtendedBuscaQuery = {
      ...baseFilters,
      cnae_codes: ['8630-5/04'],
    }
    const { text } = buildContactsQuery(extFilters)
    expect(text).toMatch(/= ANY\(/i)
    expect(text).not.toContain('ILIKE')
  })

  it('applies all filters correctly for a large limit request', () => {
    const extFilters: ExtendedBuscaQuery = {
      ...baseFilters,
      uf: 'SP',
      municipio: '3550308',         // numeric — exact match
      cnae_codes: ['9602-5/01', '9602-5/02', '9602-5/03'],
      situacao_cadastral: '02',
      tem_telefone: true,
      tem_email: false,
      limit: 100,
      page: 1,
      orderBy: 'razao_social',
      orderDir: 'asc',
    }
    const { text, values } = buildContactsQuery(extFilters)

    // All WHERE predicates present
    expect(text).toMatch(/uf\s*=\s*\$\d+/i)
    expect(text).toMatch(/municipio\s*=\s*\$\d+/i)       // exact (numeric)
    expect(text).toMatch(/= ANY\(/i)                       // cnae_codes
    expect(text).toMatch(/situacao_cadastral\s*=\s*\$\d+/i)
    expect(text).toMatch(/tem_telefone\s*=\s*true/i)
    expect(text).toMatch(/tem_email\s*=\s*false/i)

    // LIMIT is parameterized (not hardcoded 100 in SQL text)
    const limitMatch = text.match(/LIMIT\s+\$(\d+)/i)
    expect(limitMatch).toBeTruthy()
    const limitIdx = parseInt(limitMatch![1]) - 1
    expect(values[limitIdx]).toBe(100)
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

  it('uses ILIKE wildcard for text municipio', () => {
    const { text, values } = buildCountQuery({ municipio: 'Niteroi' })
    expect(text).toContain('$1')
    expect(values[0]).toBe('%Niteroi%')
  })

  it('uses exact match for numeric municipio code', () => {
    const { text, values } = buildCountQuery({ municipio: '3304557' })
    expect(text).toMatch(/municipio\s*=\s*\$\d+/i)
    expect(values[0]).toBe('3304557')
  })

  it('uses = ANY for cnae_codes in count query', () => {
    const { text, values } = buildCountQuery({ cnae_codes: ['9602-5/01', '9602-5/02'] })
    expect(text).toMatch(/=\s*ANY\(/i)
    const codesParam = values.find((v) => Array.isArray(v)) as string[]
    expect(codesParam).toEqual(['9602501', '9602502'])
  })

  it('does not include LIMIT or OFFSET', () => {
    const { text } = buildCountQuery({ municipio: 'test' })
    expect(text).not.toMatch(/LIMIT/i)
    expect(text).not.toMatch(/OFFSET/i)
  })
})
