import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Unit tests for lib/csv-import-parser.ts (TDD — RED state)
//
// Pure function tests — no mocks, no HTTP, no DB.
// These tests define the contract for the CSV import parser.
// They will fail until lib/csv-import-parser.ts is implemented.
// ---------------------------------------------------------------------------

import { parseCsvLeads } from '@/lib/csv-import-parser'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CSV_COMMA_2ROWS = `cnpj,razao_social,uf,municipio,telefone,email
12345678000195,Empresa Alpha Ltda,SP,SAO PAULO,11999999999,alpha@test.com
98765432000100,Empresa Beta Ltda,RJ,RIO DE JANEIRO,21888888888,beta@test.com`

const CSV_SEMICOLON = `cnpj;razao_social;uf;municipio;telefone;email
12345678000195;Empresa Alpha Ltda;SP;SAO PAULO;11999999999;alpha@test.com`

const CSV_CRLF = `cnpj,razao_social,uf\r\n12345678000195,Empresa Alpha Ltda,SP`

const CSV_ACCENTS = `cnpj,razao_social,municipio
12345678000195,Clínica Médica São João,São Paulo`

const CSV_UPPERCASE_HEADERS = `CNPJ,RAZAO_SOCIAL,UF
12345678000195,Empresa Test,SP`

const CSV_MIXED_CASE_HEADERS = `Cnpj,RazaoSocial,Uf
12345678000195,Empresa Test,SP`

const CSV_SYNONYM_NOME = `cnpj,nome,uf
12345678000195,Empresa Nome Ltda,SP`

const CSV_SYNONYM_EMPRESA = `cnpj,empresa,cidade
12345678000195,Minha Empresa,Curitiba`

const CSV_SYNONYM_ESTADO = `cnpj,razao_social,estado
12345678000195,Empresa Test,PR`

const CSV_SYNONYM_FONE = `cnpj,razao_social,fone
12345678000195,Empresa Test,11999999999`

const CSV_TWO_PHONES = `cnpj,razao_social,telefone,telefone2
12345678000195,Empresa Test,11999999999,11888888888`

const CSV_FONE2 = `cnpj,razao_social,fone,fone2
12345678000195,Empresa Test,11999999999,11888888888`

const CSV_DEDUP = `cnpj,razao_social
12345678000195,Empresa Alpha
12345678000195,Empresa Alpha Duplicada`

const CSV_INJECTION = `cnpj,razao_social
12345678000195,=HYPERLINK("http://evil.com","Click here")`

const CSV_NO_HEADERS = `foo,bar,baz
1,2,3`

const CSV_EMPTY = ``

function makeLargeCSV(rows: number): string {
  const header = 'cnpj,razao_social'
  const dataRows = Array.from({ length: rows }, (_, i) =>
    `${String(i).padStart(14, '0')},Empresa ${i}`,
  )
  return [header, ...dataRows].join('\n')
}

// ---------------------------------------------------------------------------
// Delimiter detection
// ---------------------------------------------------------------------------

describe('parseCsvLeads — delimiters', () => {
  it('parses comma-delimited CSV and returns 2 leads', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
  })

  it('parses semicolon-delimited CSV', () => {
    const result = parseCsvLeads(CSV_SEMICOLON)
    expect(result.leads).toHaveLength(1)
    expect(result.errors).toHaveLength(0)
  })

  it('handles \\r\\n (Windows) line endings', () => {
    const result = parseCsvLeads(CSV_CRLF)
    expect(result.leads).toHaveLength(1)
    expect(result.leads[0].cnpj).toBe('12345678000195')
  })

  it('accepts explicit delimiter override (semicolon)', () => {
    const result = parseCsvLeads(CSV_SEMICOLON, { delimiter: ';' })
    expect(result.leads).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Header mapping — standard columns
// ---------------------------------------------------------------------------

describe('parseCsvLeads — standard header mapping', () => {
  it('maps "razao_social" → razaoSocial', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].razaoSocial).toBe('Empresa Alpha Ltda')
  })

  it('maps "cnpj" → cnpj', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].cnpj).toBe('12345678000195')
  })

  it('maps "uf" → uf', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].uf).toBe('SP')
  })

  it('maps "municipio" → municipio', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].municipio).toBe('SAO PAULO')
  })

  it('maps "telefone" → telefone1', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].telefone1).toBe('11999999999')
  })

  it('maps "email" → email', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.leads[0].email).toBe('alpha@test.com')
  })
})

// ---------------------------------------------------------------------------
// Header mapping — case-insensitive & synonyms
// ---------------------------------------------------------------------------

describe('parseCsvLeads — case-insensitive headers', () => {
  it('maps UPPERCASE headers (CNPJ, RAZAO_SOCIAL, UF)', () => {
    const result = parseCsvLeads(CSV_UPPERCASE_HEADERS)
    expect(result.leads[0].cnpj).toBe('12345678000195')
    expect(result.leads[0].razaoSocial).toBe('Empresa Test')
    expect(result.leads[0].uf).toBe('SP')
  })

  it('maps mixed-case headers (Cnpj, RazaoSocial, Uf)', () => {
    const result = parseCsvLeads(CSV_MIXED_CASE_HEADERS)
    expect(result.leads[0].cnpj).toBe('12345678000195')
    expect(result.leads[0].razaoSocial).toBe('Empresa Test')
  })
})

describe('parseCsvLeads — synonym headers', () => {
  it('maps "nome" as synonym for razaoSocial', () => {
    const result = parseCsvLeads(CSV_SYNONYM_NOME)
    expect(result.leads[0].razaoSocial).toBe('Empresa Nome Ltda')
  })

  it('maps "empresa" as synonym for razaoSocial', () => {
    const result = parseCsvLeads(CSV_SYNONYM_EMPRESA)
    expect(result.leads[0].razaoSocial).toBe('Minha Empresa')
  })

  it('maps "cidade" as synonym for municipio', () => {
    const result = parseCsvLeads(CSV_SYNONYM_EMPRESA)
    expect(result.leads[0].municipio).toBe('Curitiba')
  })

  it('maps "estado" as synonym for uf', () => {
    const result = parseCsvLeads(CSV_SYNONYM_ESTADO)
    expect(result.leads[0].uf).toBe('PR')
  })

  it('maps "fone" as synonym for telefone1', () => {
    const result = parseCsvLeads(CSV_SYNONYM_FONE)
    expect(result.leads[0].telefone1).toBe('11999999999')
  })

  it('maps "telefone2" → telefone2', () => {
    const result = parseCsvLeads(CSV_TWO_PHONES)
    expect(result.leads[0].telefone1).toBe('11999999999')
    expect(result.leads[0].telefone2).toBe('11888888888')
  })

  it('maps "fone2" as synonym for telefone2', () => {
    const result = parseCsvLeads(CSV_FONE2)
    expect(result.leads[0].telefone2).toBe('11888888888')
  })
})

// ---------------------------------------------------------------------------
// UTF-8 / accents
// ---------------------------------------------------------------------------

describe('parseCsvLeads — UTF-8 accents', () => {
  it('preserves accented characters in razaoSocial', () => {
    const result = parseCsvLeads(CSV_ACCENTS)
    expect(result.leads[0].razaoSocial).toBe('Clínica Médica São João')
  })

  it('preserves accented characters in municipio', () => {
    const result = parseCsvLeads(CSV_ACCENTS)
    expect(result.leads[0].municipio).toBe('São Paulo')
  })
})

// ---------------------------------------------------------------------------
// Error cases — empty / bad structure
// ---------------------------------------------------------------------------

describe('parseCsvLeads — structural errors', () => {
  it('returns error for empty file content', () => {
    const result = parseCsvLeads(CSV_EMPTY)
    expect(result.leads).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].message).toMatch(/vazio|empty/i)
  })

  it('returns error when no recognised columns found', () => {
    const result = parseCsvLeads(CSV_NO_HEADERS)
    expect(result.leads).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].message).toMatch(/coluna|column|header|reconhec/i)
  })

  it('returns error when row count exceeds 500 (schema max)', () => {
    const csv = makeLargeCSV(501)
    const result = parseCsvLeads(csv)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].message).toMatch(/limite|limit|500/i)
  })

  it('accepts exactly 500 rows without error', () => {
    const csv = makeLargeCSV(500)
    const result = parseCsvLeads(csv)
    // No structural errors about row limit
    const limitErrors = result.errors.filter((e) => /limite|limit|500/i.test(e.message))
    expect(limitErrors).toHaveLength(0)
    expect(result.leads).toHaveLength(500)
  })
})

// ---------------------------------------------------------------------------
// Partial import policy
// ---------------------------------------------------------------------------

describe('parseCsvLeads — partial import policy', () => {
  it('imports valid rows even when some rows have errors (default partial policy)', () => {
    const csv = `cnpj,razao_social
12345678000195,Empresa Valida
,`  // empty cnpj + empty name = invalid row
    const result = parseCsvLeads(csv)
    expect(result.leads.length).toBeGreaterThan(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rowCount reflects total data rows (excluding header), including errored rows', () => {
    const result = parseCsvLeads(CSV_COMMA_2ROWS)
    expect(result.rowCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('parseCsvLeads — CNPJ deduplication', () => {
  it('deduplicates leads by CNPJ — keeps first occurrence', () => {
    const result = parseCsvLeads(CSV_DEDUP)
    expect(result.leads).toHaveLength(1)
    expect(result.leads[0].cnpj).toBe('12345678000195')
    expect(result.leads[0].razaoSocial).toBe('Empresa Alpha')
  })
})

// ---------------------------------------------------------------------------
// CSV injection characters (parser responsibility: preserve raw values)
// ---------------------------------------------------------------------------

describe('parseCsvLeads — CSV injection passthrough', () => {
  it('preserves raw cell value even if it starts with = (sanitization is the exporter\'s job)', () => {
    const result = parseCsvLeads(CSV_INJECTION)
    expect(result.leads[0].razaoSocial).toBe('=HYPERLINK("http://evil.com","Click here")')
  })

  it('does not strip + or @ prefixes from cell values', () => {
    const csv = `cnpj,razao_social
12345678000195,+31234567890`
    const result = parseCsvLeads(csv)
    expect(result.leads[0].razaoSocial).toBe('+31234567890')
  })
})
