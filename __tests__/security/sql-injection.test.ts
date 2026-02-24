import { describe, it, expect } from 'vitest'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { BuscaQuerySchema } from '@/lib/schemas'
import type { BuscaQuery } from '@/lib/schemas'

// ---------------------------------------------------------------------------
// SQL Injection resistance tests
//
// These tests verify that:
// 1. The schema rejects obviously malicious inputs before they reach the DB
// 2. Inputs that pass schema validation are properly parameterized in the query
//
// The queries are NOT executed against a real DB here — that is the job of
// integration tests. Here we verify that the SQL text NEVER contains the
// raw payload, and that all values go through the parameterized values array.
// ---------------------------------------------------------------------------

const SQL_INJECTION_PAYLOADS = [
  "'; DROP TABLE estabelecimentos; --",
  "' OR '1'='1",
  "' UNION SELECT * FROM pg_user --",
  "1; SELECT pg_sleep(5) --",
  "' OR 1=1; --",
  "admin'--",
  "' OR 'x'='x",
  "'; INSERT INTO estabelecimentos VALUES ('hacker') --",
  "1' AND SLEEP(5) --",
  "'; EXEC xp_cmdshell('dir') --",
]

const baseFilters: BuscaQuery = {
  page: 1,
  limit: 20,
  orderBy: 'razao_social',
  orderDir: 'asc',
  situacao_cadastral: '02',
}

describe('SQL Injection — schema validation layer', () => {
  it('rejects SQL keywords in orderBy (enforced by z.enum whitelist)', () => {
    for (const payload of SQL_INJECTION_PAYLOADS) {
      expect(() =>
        BuscaQuerySchema.parse({ orderBy: payload })
      ).toThrow()
    }
  })

  it('rejects SQL keywords in orderDir', () => {
    expect(() =>
      BuscaQuerySchema.parse({ orderDir: '; DROP TABLE estabelecimentos; --' })
    ).toThrow()
  })

  it('rejects municipio over 150 chars (length-based bypass prevention)', () => {
    expect(() =>
      BuscaQuerySchema.parse({ municipio: 'a'.repeat(200) })
    ).toThrow()
  })

  it('rejects invalid situacao_cadastral (enum whitelist)', () => {
    expect(() =>
      BuscaQuerySchema.parse({ situacao_cadastral: "'; DROP TABLE estabelecimentos; --" })
    ).toThrow()
  })
})

describe('SQL Injection — query builder parameterization', () => {
  for (const payload of SQL_INJECTION_PAYLOADS) {
    it(`parameterizes payload in municipio: "${payload.slice(0, 40)}"`, () => {
      const { text, values } = buildContactsQuery({ ...baseFilters, municipio: payload })
      // The SQL text must NEVER contain the raw payload
      expect(text).not.toContain(payload)
      // The payload must be in values (parameterized), wrapped in % for ILIKE
      expect(values).toContain(`%${payload}%`)
      // The SQL text must use a $N placeholder
      expect(text).toMatch(/\$\d+/)
    })
  }

  it('never produces SQL text with raw user strings for any filter combination', () => {
    const dangerousFilters: BuscaQuery = {
      ...baseFilters,
      municipio: "'; DROP TABLE estabelecimentos; --",
      cnae_principal: "' UNION SELECT * FROM pg_user --",
    }
    const { text, values } = buildContactsQuery(dangerousFilters)
    // None of the raw payloads should appear in the SQL text
    expect(text).not.toContain("DROP TABLE")
    expect(text).not.toContain("UNION SELECT")
    // All payloads should be in values array (parameterized)
    expect(values.length).toBeGreaterThan(2)
  })

  it('uf exact match never exposes user input in SQL text', () => {
    const { text, values } = buildContactsQuery({ ...baseFilters, uf: 'SP' })
    expect(text).not.toContain('SP')  // appears only in values, not SQL text
    expect(values).toContain('SP')
  })
})

describe('SQL Injection — count query parameterization', () => {
  for (const payload of SQL_INJECTION_PAYLOADS) {
    it(`count query parameterizes payload: "${payload.slice(0, 40)}"`, () => {
      const { text, values } = buildCountQuery({ municipio: payload })
      expect(text).not.toContain(payload)
      expect(values).toContain(`%${payload}%`)
      expect(text).toContain('$1')
    })
  }
})
