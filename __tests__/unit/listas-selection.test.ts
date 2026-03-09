// ---------------------------------------------------------------------------
// Unit tests — buildRecipients() from /whatsapp/listas/page.tsx
//
// buildRecipients is a pure function: it filters leads by selectedIds and
// maps them to the shape expected by POST /api/campaigns `recipients`.
// Tests run entirely in-process — no React, no DB, no network required.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { buildRecipients } from '@/app/whatsapp/listas/page'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLead(cnpj: string, overrides: Partial<PublicEmpresa> = {}): PublicEmpresa {
  return {
    cnpj,
    razaoSocial:   `Empresa ${cnpj}`,
    nomeFantasia:  '',
    uf:            'AM',
    municipio:     'MANAUS',
    cnaePrincipal: '9602-5/01',
    situacao:      'ATIVA',
    telefone1:     '92999990000',
    telefone2:     '',
    email:         '',
    ...overrides,
  }
}

const LEAD_A = makeLead('11111111000191', { razaoSocial: 'Alpha Ltda', telefone1: '11111111111' })
const LEAD_B = makeLead('22222222000182', { razaoSocial: 'Beta Ltda',  telefone1: '22222222222' })
const LEAD_C = makeLead('33333333000173', { razaoSocial: 'Gamma Ltda', telefone1: '33333333333' })

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('buildRecipients — empty selection', () => {
  it('throws when selectedIds is empty (no lead selected)', () => {
    expect(() => buildRecipients([LEAD_A, LEAD_B], new Set())).toThrow('Selecione ao menos 1 lead.')
  })

  it('throws when all leads are explicitly set to false', () => {
    const none = new Set<string>()
    expect(() => buildRecipients([LEAD_A, LEAD_B], none)).toThrow('Selecione ao menos 1 lead.')
  })

  it('throws when leads array is empty regardless of selectedIds', () => {
    const ids = new Set([LEAD_A.cnpj])
    expect(() => buildRecipients([], ids)).toThrow('Selecione ao menos 1 lead.')
  })
})

// ---------------------------------------------------------------------------
// Partial selection
// ---------------------------------------------------------------------------

describe('buildRecipients — partial selection', () => {
  it('returns only selected leads when selection is a strict subset', () => {
    const selectedIds = new Set([LEAD_A.cnpj])
    const result = buildRecipients([LEAD_A, LEAD_B, LEAD_C], selectedIds)

    expect(result).toHaveLength(1)
    expect(result[0].cnpj).toBe(LEAD_A.cnpj)
    expect(result[0].razao_social).toBe('Alpha Ltda')
  })

  it('includes multiple selected leads in original order', () => {
    const selectedIds = new Set([LEAD_A.cnpj, LEAD_C.cnpj])
    const result = buildRecipients([LEAD_A, LEAD_B, LEAD_C], selectedIds)

    expect(result).toHaveLength(2)
    expect(result[0].cnpj).toBe(LEAD_A.cnpj)
    expect(result[1].cnpj).toBe(LEAD_C.cnpj)
    // LEAD_B must not appear
    expect(result.map((r) => r.cnpj)).not.toContain(LEAD_B.cnpj)
  })

  it('campaign is NOT created for deselected leads (no phantom recipients)', () => {
    const selectedIds = new Set([LEAD_B.cnpj])
    const result = buildRecipients([LEAD_A, LEAD_B, LEAD_C], selectedIds)

    const cnpjs = result.map((r) => r.cnpj)
    expect(cnpjs).not.toContain(LEAD_A.cnpj)
    expect(cnpjs).not.toContain(LEAD_C.cnpj)
    expect(cnpjs).toContain(LEAD_B.cnpj)
  })
})

// ---------------------------------------------------------------------------
// Full selection
// ---------------------------------------------------------------------------

describe('buildRecipients — full selection', () => {
  it('returns all leads when every lead is selected', () => {
    const allSelected = new Set([LEAD_A.cnpj, LEAD_B.cnpj, LEAD_C.cnpj])
    const result = buildRecipients([LEAD_A, LEAD_B, LEAD_C], allSelected)
    expect(result).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe('buildRecipients — recipient field mapping', () => {
  it('maps razaoSocial → razao_social and nomeFantasia → nome_fantasia', () => {
    const lead = makeLead('44444444000164', {
      razaoSocial:  'Razão Social SA',
      nomeFantasia: 'Nome Fantasia',
    })
    const result = buildRecipients([lead], new Set([lead.cnpj]))

    expect(result[0].razao_social).toBe('Razão Social SA')
    expect(result[0].nome_fantasia).toBe('Nome Fantasia')
  })

  it('omits nome_fantasia when nomeFantasia is empty string', () => {
    const lead = makeLead('55555555000155', { nomeFantasia: '' })
    const result = buildRecipients([lead], new Set([lead.cnpj]))

    expect(result[0].nome_fantasia).toBeUndefined()
  })

  it('prefers telefone1 over telefone2 for the telefone field', () => {
    const lead = makeLead('66666666000146', {
      telefone1: '11111111111',
      telefone2: '22222222222',
    })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].telefone).toBe('11111111111')
  })

  it('falls back to telefone2 when telefone1 is empty', () => {
    const lead = makeLead('77777777000137', {
      telefone1: '',
      telefone2: '22222222222',
    })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].telefone).toBe('22222222222')
  })

  it('sets uf and municipio from lead fields', () => {
    const lead = makeLead('88888888000128', { uf: 'AM', municipio: 'MANAUS' })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].uf).toBe('AM')
    expect(result[0].municipio).toBe('MANAUS')
  })
})

