import { describe, it, expect } from 'vitest'
import { maskContact, type EmpresaRow } from '@/lib/mask-output'

const makeRow = (overrides: Partial<EmpresaRow> = {}): EmpresaRow => ({
  cnpj_completo: '11222333000181',
  razao_social: 'CLINICA ODONTO LTDA',
  nome_fantasia: 'Odonto SP',
  uf: 'SP',
  municipio: 'SAO PAULO',
  cnae_principal: '8630-5/04',
  situacao_cadastral: 'ATIVA',
  telefone1: '11999990000',
  telefone2: null,
  correio_eletronico: 'contato@odonto.com',
  ...overrides,
})

describe('maskContact', () => {
  it('returns only the 10 allowed public fields', () => {
    const result = maskContact(makeRow())
    const keys = Object.keys(result)
    expect(keys).toEqual([
      'cnpj', 'razaoSocial', 'nomeFantasia', 'uf', 'municipio',
      'cnaePrincipal', 'situacao', 'telefone1', 'telefone2', 'email',
    ])
    expect(keys).toHaveLength(10)
  })

  it('maps cnpj_completo to cnpj', () => {
    const result = maskContact(makeRow())
    expect(result.cnpj).toBe('11222333000181')
  })

  it('maps razao_social to razaoSocial', () => {
    const result = maskContact(makeRow())
    expect(result.razaoSocial).toBe('CLINICA ODONTO LTDA')
  })

  it('defaults null nome_fantasia to empty string', () => {
    const result = maskContact(makeRow({ nome_fantasia: null }))
    expect(result.nomeFantasia).toBe('')
  })

  it('maps cnae_principal to cnaePrincipal', () => {
    const result = maskContact(makeRow())
    expect(result.cnaePrincipal).toBe('8630-5/04')
  })

  it('maps situacao_cadastral to situacao', () => {
    const result = maskContact(makeRow())
    expect(result.situacao).toBe('ATIVA')
  })

  it('defaults null telefone1 to empty string', () => {
    const result = maskContact(makeRow({ telefone1: null }))
    expect(result.telefone1).toBe('')
  })

  it('defaults null telefone2 to empty string', () => {
    const result = maskContact(makeRow({ telefone2: null }))
    expect(result.telefone2).toBe('')
  })

  it('maps correio_eletronico to email, defaults null to empty string', () => {
    const result = maskContact(makeRow({ correio_eletronico: null }))
    expect(result.email).toBe('')
  })

  it('does not expose internal DB fields even if present in row object', () => {
    const row = makeRow() as EmpresaRow & { internal_notes: string }
    row.internal_notes = 'Do not contact'
    const result = maskContact(row)
    expect('internal_notes' in result).toBe(false)
  })

  it('preserves all public field values correctly', () => {
    const result = maskContact(makeRow())
    expect(result.cnpj).toBe('11222333000181')
    expect(result.razaoSocial).toBe('CLINICA ODONTO LTDA')
    expect(result.nomeFantasia).toBe('Odonto SP')
    expect(result.uf).toBe('SP')
    expect(result.municipio).toBe('SAO PAULO')
    expect(result.cnaePrincipal).toBe('8630-5/04')
    expect(result.situacao).toBe('ATIVA')
    expect(result.telefone1).toBe('11999990000')
    expect(result.telefone2).toBe('')
    expect(result.email).toBe('contato@odonto.com')
  })
})
