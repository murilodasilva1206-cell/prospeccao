// ---------------------------------------------------------------------------
// TDD — Hook useConversations: análise estática dos filtros (seção 3)
//
// Cobre:
//   3a. Monta querystring com todos os filtros ativos
//   3b. Não envia parâmetros vazios/undefined
//   3c. Reset de paginação ao trocar filtros
//   3d. Refetch mantém filtros atuais
//   3e. Polling respeita filtros (não "perde" estado)
//
// Estratégia: análise estática do source (readFileSync) — mesmo padrão usado
// em templates-page-ui.test.ts — sem necessidade de @testing-library/react.
//
// STATUS: RED — useConversations ainda não aceita provider/channel_id/
//         date_from/date_to/preset; os checks de source falharão.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')
let src = ''
try {
  src = readFileSync(
    resolve(ROOT, 'app/whatsapp/inbox/hooks/useConversations.ts'),
    'utf-8',
  )
} catch {
  // Arquivo ausente → todos os expect falharão com mensagem clara
  src = ''
}

// ---------------------------------------------------------------------------
// 3a. Monta querystring com todos os filtros ativos
// ---------------------------------------------------------------------------

describe('useConversations — construção da querystring', () => {
  it('envia limit na querystring', () => {
    expect(src).toMatch(/params\.set\(['"]limit['"]/)
  })

  it('envia status na querystring quando definido', () => {
    // Deve haver um condicional que adiciona status
    expect(src).toMatch(/status.*params\.set|params\.set.*status/i)
  })

  it('envia provider na querystring quando definido', () => {
    // Novo filtro: provider deve ser adicionado aos params quando fornecido
    expect(src).toMatch(/provider.*params\.set|params\.set.*['"]provider['"]/i)
  })

  it('envia channel_id na querystring quando definido', () => {
    expect(src).toMatch(/channel_id.*params\.set|params\.set.*['"]channel_id['"]/i)
  })

  it('envia date_from na querystring quando definido', () => {
    expect(src).toMatch(/date_from.*params\.set|params\.set.*['"]date_from['"]/i)
  })

  it('envia date_to na querystring quando definido', () => {
    expect(src).toMatch(/date_to.*params\.set|params\.set.*['"]date_to['"]/i)
  })

  it('envia preset na querystring quando definido', () => {
    expect(src).toMatch(/preset.*params\.set|params\.set.*['"]preset['"]/i)
  })

  it('usa URLSearchParams para construir a querystring', () => {
    expect(src).toContain('URLSearchParams')
  })
})

// ---------------------------------------------------------------------------
// 3b. Não envia parâmetros vazios/undefined
// ---------------------------------------------------------------------------

describe('useConversations — não envia params vazios', () => {
  it('provider é adicionado condicionalmente (if/&&)', () => {
    // Deve ter um guard antes de params.set('provider', ...)
    // Padrão: if (provider) params.set('provider', provider)
    // ou: provider && params.set(...)
    const hasConditional =
      /if\s*\(.*provider\)[\s\S]{0,80}params\.set.*provider/i.test(src) ||
      /provider\s*&&\s*params\.set/i.test(src) ||
      /provider\b[\s\S]{0,30}params\.set\(['"]provider/i.test(src)
    expect(hasConditional).toBe(true)
  })

  it('channel_id é adicionado condicionalmente', () => {
    const hasConditional =
      /if\s*\(.*channel_id\)[\s\S]{0,80}params\.set.*channel_id/i.test(src) ||
      /channel_id\s*&&\s*params\.set/i.test(src) ||
      /channel_id\b[\s\S]{0,30}params\.set\(['"]channel_id/i.test(src)
    expect(hasConditional).toBe(true)
  })

  it('date_from é adicionado condicionalmente', () => {
    const hasConditional =
      /if\s*\(.*date_from\)[\s\S]{0,80}params\.set.*date_from/i.test(src) ||
      /date_from\s*&&\s*params\.set/i.test(src) ||
      /date_from\b[\s\S]{0,30}params\.set\(['"]date_from/i.test(src)
    expect(hasConditional).toBe(true)
  })

  it('date_to é adicionado condicionalmente', () => {
    const hasConditional =
      /if\s*\(.*date_to\)[\s\S]{0,80}params\.set.*date_to/i.test(src) ||
      /date_to\s*&&\s*params\.set/i.test(src) ||
      /date_to\b[\s\S]{0,30}params\.set\(['"]date_to/i.test(src)
    expect(hasConditional).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3c. Reset de paginação ao trocar filtros
// ---------------------------------------------------------------------------

describe('useConversations — reset de paginação ao trocar filtros', () => {
  it('hook aceita parâmetro offset ou page para paginação', () => {
    // O hook precisa expor algum mecanismo de paginação
    expect(src).toMatch(/offset|page\b/)
  })

  it('fetchConversations reseta offset/page quando filtros mudam', () => {
    // Ao mudar um filtro, a paginação deve voltar ao início
    // Pode ser via setOffset(0), setPage(1), ou recalcular nas deps do useCallback
    const hasReset =
      /setOffset\s*\(\s*0\s*\)/.test(src) ||
      /setPage\s*\(\s*1\s*\)/.test(src) ||
      // Ou: offset/page reset via useEffect quando filtros mudam
      /\[.*provider.*\]|\[.*channel_id.*\]|\[.*date_from.*\]/.test(src)
    expect(hasReset).toBe(true)
  })

  it('novos filtros são dependency do useCallback de fetchConversations', () => {
    // fetchConversations deve re-criar quando qualquer filtro muda
    // Verifica que provider/channel_id/date_from/date_to estão no deps array
    const hasDeps =
      /useCallback[\s\S]{0,500}provider[\s\S]{0,200}\]/.test(src) ||
      /useCallback[\s\S]{0,500}channel_id[\s\S]{0,200}\]/.test(src) ||
      // Ou os filtros são passados via options que já é dependência
      /useCallback[\s\S]{0,200}\[.*options\b/.test(src)
    expect(hasDeps).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3d. Refetch mantém filtros atuais
// ---------------------------------------------------------------------------

describe('useConversations — refetch com filtros atuais', () => {
  it('expõe função refetch', () => {
    expect(src).toMatch(/refetch/)
  })

  it('refetch usa os mesmos filtros do estado atual (não reseta filtros)', () => {
    // refetch deve chamar fetchConversations que já fecha sobre os filtros atuais
    expect(src).toMatch(/refetch.*fetchConversations|fetchConversations.*refetch/i)
  })
})

// ---------------------------------------------------------------------------
// 3e. Polling respeita filtros
// ---------------------------------------------------------------------------

describe('useConversations — polling respeita filtros', () => {
  it('setInterval usa fetchConversations que já contém os filtros atuais', () => {
    // O polling chama fetchConversations periodicamente;
    // fetchConversations é recriada quando filtros mudam (via deps do useCallback)
    expect(src).toMatch(/setInterval.*fetchConversations|setInterval[\s\S]{0,50}fetchConversations/i)
  })

  it('useEffect re-registra o intervalo quando fetchConversations muda (filtros mudam)', () => {
    // useEffect([fetchConversations, pollInterval]) recria o intervalo
    expect(src).toMatch(/useEffect[\s\S]{0,200}fetchConversations[\s\S]{0,100}pollInterval|\[fetchConversations.*pollInterval\]/)
  })

  it('clearInterval é chamado no cleanup do useEffect (sem memory leak)', () => {
    expect(src).toContain('clearInterval')
  })

  it('hook aceita os novos parâmetros na interface UseConversationsOptions', () => {
    // A interface deve declarar os novos campos
    expect(src).toMatch(/provider\??:\s*string|provider\??:.*Provider/)
    expect(src).toMatch(/channel_id\??:\s*string/)
  })
})
