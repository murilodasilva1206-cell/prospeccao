import { describe, it, expect } from 'vitest'
import { buildRecipients } from '@/app/whatsapp/listas/page'
import type { PublicEmpresa } from '@/lib/mask-output'

// ---------------------------------------------------------------------------
// Integration tests — imported CSV leads ↔ campaign system
//
// Verifies that leads created via CSV import (which may have empty fields
// not present in CNPJ-registry data) work correctly with:
//   - buildRecipients() — used in the UI to create campaign recipients
//   - The expected recipient shape for POST /api/campaigns
//
// These tests do NOT require the import route to be implemented.
// They test that the *shape* of imported leads is compatible with the
// existing campaign creation pipeline.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Simulates a lead created from CSV import.
 * CSV leads may have empty cnpj, uf, cnaePrincipal, situacao — only
 * razaoSocial and telefone1 are commonly present.
 */
function makeImportedLead(overrides: Partial<PublicEmpresa> = {}): PublicEmpresa {
  return {
    cnpj:          '',           // often absent in imported CSV
    razaoSocial:   'Empresa Importada',
    nomeFantasia:  '',
    uf:            '',
    municipio:     '',
    cnaePrincipal: '',
    situacao:      '',
    telefone1:     '11999999999',
    telefone2:     '',
    email:         '',
    ...overrides,
  }
}

/** Lead with full CNPJ (e.g., imported from a well-structured CSV) */
function makeImportedLeadWithCnpj(cnpj: string, overrides: Partial<PublicEmpresa> = {}): PublicEmpresa {
  return makeImportedLead({ cnpj, ...overrides })
}

// ---------------------------------------------------------------------------
// buildRecipients with imported leads
// ---------------------------------------------------------------------------

describe('Campaign integration — imported leads with phone number', () => {
  it('buildRecipients maps razaoSocial → razao_social for imported leads', () => {
    const lead = makeImportedLead({ razaoSocial: 'Dr. João Clínica', telefone1: '11999990001' })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].razao_social).toBe('Dr. João Clínica')
  })

  it('recipient telefone is populated from telefone1', () => {
    const lead = makeImportedLead({ telefone1: '11999990002' })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].telefone).toBe('11999990002')
  })

  it('recipient telefone falls back to telefone2 when telefone1 is empty', () => {
    const lead = makeImportedLead({ telefone1: '', telefone2: '21888880001' })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].telefone).toBe('21888880001')
  })
})

describe('Campaign integration — imported leads with full CNPJ', () => {
  it('three leads — only selected subset goes to campaign', () => {
    const lead1 = makeImportedLeadWithCnpj('11111111000191', { razaoSocial: 'Empresa A', telefone1: '11111111111' })
    const lead2 = makeImportedLeadWithCnpj('22222222000182', { razaoSocial: 'Empresa B', telefone1: '22222222222' })
    const lead3 = makeImportedLeadWithCnpj('33333333000173', { razaoSocial: 'Empresa C', telefone1: '33333333333' })

    const selectedIds = new Set([lead1.cnpj, lead3.cnpj])
    const result = buildRecipients([lead1, lead2, lead3], selectedIds)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.cnpj)).toContain('11111111000191')
    expect(result.map((r) => r.cnpj)).toContain('33333333000173')
    expect(result.map((r) => r.cnpj)).not.toContain('22222222000182')
  })

  it('selecting all imported leads creates a recipient for each', () => {
    const leads = [
      makeImportedLeadWithCnpj('11111111000191', { telefone1: '11111111111' }),
      makeImportedLeadWithCnpj('22222222000182', { telefone1: '22222222222' }),
    ]
    const all = new Set(leads.map((l) => l.cnpj))
    const result = buildRecipients(leads, all)
    expect(result).toHaveLength(2)
  })
})

describe('Campaign integration — eligibility rules for imported leads', () => {
  it('lead without telefone1 and telefone2 still produces a recipient (telefone is empty string or undefined)', () => {
    const lead = makeImportedLeadWithCnpj('44444444000164', {
      telefone1: '',
      telefone2: '',
    })
    // buildRecipients should not throw — the campaign API decides eligibility
    expect(() => buildRecipients([lead], new Set([lead.cnpj]))).not.toThrow()
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    // telefone should be empty or undefined — not a hard crash
    expect(result[0].telefone == null || result[0].telefone === '').toBe(true)
  })

  it('empty selection throws a clear user-facing error', () => {
    const lead = makeImportedLeadWithCnpj('55555555000155', { telefone1: '11999999999' })
    expect(() => buildRecipients([lead], new Set())).toThrow('Selecione ao menos 1 lead.')
  })

  it('empty leads array throws even with non-empty selectedIds', () => {
    expect(() => buildRecipients([], new Set(['55555555000155']))).toThrow()
  })
})

describe('Campaign integration — email-only leads', () => {
  it('lead with email but no phone produces a recipient with email field populated', () => {
    const lead = makeImportedLeadWithCnpj('66666666000146', {
      telefone1: '',
      telefone2: '',
      email:     'contato@empresa.com.br',
    })
    const result = buildRecipients([lead], new Set([lead.cnpj]))
    expect(result[0].email).toBe('contato@empresa.com.br')
  })
})

describe('Campaign integration — lead_count consistency', () => {
  it('lead_count in pool matches the number of leads that were imported', () => {
    // This simulates checking that what the parser returns matches lead_count
    const parsedLeads: PublicEmpresa[] = [
      makeImportedLeadWithCnpj('11111111000191'),
      makeImportedLeadWithCnpj('22222222000182'),
      makeImportedLeadWithCnpj('33333333000173'),
    ]
    // When a pool is created, lead_count = leads.length
    const expectedLeadCount = parsedLeads.length
    expect(expectedLeadCount).toBe(3)
    // buildRecipients with all selected should match
    const all = new Set(parsedLeads.map((l) => l.cnpj))
    const recipients = buildRecipients(parsedLeads, all)
    expect(recipients).toHaveLength(expectedLeadCount)
  })
})
