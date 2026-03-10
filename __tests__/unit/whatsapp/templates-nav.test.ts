// ---------------------------------------------------------------------------
// Unit: Navigation & structure — Templates tab (TDD — RED until implemented)
//
// Covers (cenários 1, 2, 3, 6):
//   1. Layout global NAV_LINKS contém item "Templates" → /whatsapp/templates
//   2. /whatsapp/page.tsx expõe card/link para /whatsapp/templates
//   3. app/whatsapp/templates/page.tsx existe (arquivo da página)
//   6. Regressão: CampaignWizard "Sincronize os templates" aponta para
//      /whatsapp/templates (não /whatsapp/canais)
//
// Estes testes usam análise estática do source (sem renderização React) pois
// o projeto não inclui @testing-library/react. Qualquer falha sinaliza que a
// implementação da feature ainda é necessária (estado RED do TDD).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')

// ---------------------------------------------------------------------------
// 1. Layout global — NAV_LINKS
// ---------------------------------------------------------------------------

describe('Layout /whatsapp/* — item Templates no menu global', () => {
  const src = readFileSync(resolve(ROOT, 'app/whatsapp/layout.tsx'), 'utf-8')

  it('NAV_LINKS contém href "/whatsapp/templates"', () => {
    // O array NAV_LINKS deve conter uma entrada apontando para /whatsapp/templates
    expect(src).toContain('/whatsapp/templates')
  })

  it('NAV_LINKS contém label "Templates"', () => {
    expect(src).toMatch(/['"]Templates['"]/)
  })

  it('entrada de Templates está dentro do array NAV_LINKS (não só em comentário)', () => {
    // Extrai somente o bloco do array NAV_LINKS e verifica o href lá dentro
    const navBlock = src.match(/const NAV_LINKS\s*=\s*\[[\s\S]*?\]/)?.[0] ?? ''
    expect(navBlock).toContain('/whatsapp/templates')
  })
})

// ---------------------------------------------------------------------------
// 2. Módulo /whatsapp/page.tsx — card Templates
// ---------------------------------------------------------------------------

describe('Módulo /whatsapp/page.tsx — card/link para Templates', () => {
  const src = readFileSync(resolve(ROOT, 'app/whatsapp/page.tsx'), 'utf-8')

  it('inclui href "/whatsapp/templates"', () => {
    expect(src).toContain('/whatsapp/templates')
  })

  it('inclui texto "Templates" visível para o usuário', () => {
    // Aceita tanto como string isolada quanto como title/label dentro de objeto
    expect(src).toMatch(/['"](Templates)['"]/i)
  })

  it('card de Templates aparece no array/lista de links do módulo', () => {
    // O array `links` no arquivo define os cards do módulo
    const linksBlock = src.match(/const links\s*=\s*\[[\s\S]*?\]\s*as const/)?.[0] ?? ''
    expect(linksBlock).toContain('/whatsapp/templates')
  })
})

// ---------------------------------------------------------------------------
// 3. Arquivo da página /whatsapp/templates/page.tsx
// ---------------------------------------------------------------------------

describe('Arquivo app/whatsapp/templates/page.tsx', () => {
  it('existe no sistema de arquivos', () => {
    const pagePath = resolve(ROOT, 'app/whatsapp/templates/page.tsx')
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Regressão: CampaignWizard — link "Sincronize os templates"
// ---------------------------------------------------------------------------

describe('Regressão: CampaignWizard — link "Sincronize os templates"', () => {
  const src = readFileSync(resolve(ROOT, 'app/components/CampaignWizard.tsx'), 'utf-8')

  it('aponta para /whatsapp/templates (não /whatsapp/canais)', () => {
    const textIndex = src.indexOf('Sincronize os templates')
    expect(textIndex).toBeGreaterThan(0)

    // Janela de 300 chars antes do texto para capturar o href do <a> pai
    const before = src.slice(Math.max(0, textIndex - 300), textIndex)
    expect(before).toContain('href="/whatsapp/templates"')
    expect(before).not.toContain('href="/whatsapp/canais"')
  })

  it('não menciona /whatsapp/canais no bloco de "Sincronize os templates"', () => {
    const textIndex = src.indexOf('Sincronize os templates')
    expect(textIndex).toBeGreaterThan(0)
    // 300 chars de contexto ao redor do texto
    const context = src.slice(Math.max(0, textIndex - 300), textIndex + 100)
    expect(context).not.toContain('/whatsapp/canais')
  })
})
