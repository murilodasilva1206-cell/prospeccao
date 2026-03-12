// ---------------------------------------------------------------------------
// Unit: Templates page UI -- analise estatica do comportamento da pagina
//
// Testa a implementacao em app/whatsapp/templates/page.tsx via analise de
// source (sem @testing-library/react). Verifica que:
//
//   1. Estado vazio sem canal META_CLOUD -> texto amigavel + CTA /whatsapp/canais
//   2. Sync 422 -> mensagem de "canal incompleto / sem WABA ID"
//   3. Sync 409 -> mensagem sobre META_CLOUD
//   4. Sync 429 -> usa Retry-After + mensagem de limite
//   5. Sync 500/503 -> mensagem amigavel, nao tecnica + botao tentar novamente
//   6. Botao sincronizar desabilitado durante sync (previne duplo clique)
//   7. selectedChannelId e usado na URL da requisição de sync e list
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')
const src = readFileSync(resolve(ROOT, 'app/whatsapp/templates/page.tsx'), 'utf-8')

// ---------------------------------------------------------------------------
// 1. Estado vazio -- nenhum canal META_CLOUD conectado
// ---------------------------------------------------------------------------

describe('Estado vazio -- nenhum canal META_CLOUD conectado', () => {
  it('exibe texto indicando ausencia de canal oficial', () => {
    // A pagina deve exibir uma mensagem informativa quando channels.length === 0
    expect(src).toMatch(/nenhum canal oficial/i)
  })

  it('tem botao/link CTA apontando para /whatsapp/canais', () => {
    // Usuario deve poder navegar para configurar um canal Meta
    expect(src).toContain('/whatsapp/canais')
  })

  it('condicional de estado vazio usa channels.length', () => {
    // A logica de renderizacao do estado vazio depende da lista de canais
    expect(src).toMatch(/channels\.length\s*===\s*0|channels\.length\s*==\s*0/)
  })

  it('filtra apenas canais META_CLOUD e CONNECTED ao carregar lista', () => {
    // Garante que apenas canais elegiveis aparecem no seletor
    expect(src).toContain('META_CLOUD')
    expect(src).toContain('CONNECTED')
    // Ambos usados juntos no filtro
    const filterBlock = src.match(/\.filter\([\s\S]{0,300}?META_CLOUD[\s\S]{0,300}?CONNECTED/)?.[0]
      || src.match(/\.filter\([\s\S]{0,300}?CONNECTED[\s\S]{0,300}?META_CLOUD/)?.[0]
    expect(filterBlock).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Sync 422 -- canal sem WABA ID
// ---------------------------------------------------------------------------

describe('Sync 422 -- canal sem WABA ID configurado', () => {
  it('captura status 422 explicitamente', () => {
    expect(src).toContain('422')
  })

  it('mensagem inclui referencia a WABA ID ou credenciais', () => {
    // Deve orientar o usuario a atualizar as credenciais do canal
    expect(src).toMatch(/waba\s*id|WABA\s*ID|credenciais/i)
  })

  it('mensagem 422 não é generica de servidor', () => {
    // Nao deve confundir com erro 500
    const block422 = src.match(/status\s*===\s*422[\s\S]{0,300}/)?.[0] ?? ''
    expect(block422).not.toMatch(/erro interno|server error/i)
  })
})

// ---------------------------------------------------------------------------
// 3. Sync 409 -- canal não é META_CLOUD
// ---------------------------------------------------------------------------

describe('Sync 409 -- provider nao suportado', () => {
  it('captura status 409 explicitamente', () => {
    expect(src).toContain('409')
  })

  it('mensagem 409 menciona META_CLOUD ou operação nao suportada', () => {
    const block409 = src.match(/status\s*===\s*409[\s\S]{0,300}/)?.[0] ?? ''
    expect(block409).toMatch(/META_CLOUD|nao suportad|somente|apenas/i)
  })
})

// ---------------------------------------------------------------------------
// 4. Sync 429 -- rate limit
// ---------------------------------------------------------------------------

describe('Sync 429 -- limite de requisições', () => {
  it('captura status 429 explicitamente', () => {
    expect(src).toContain('429')
  })

  it('le Retry-After do header para informar o usuario', () => {
    // A pagina usa o header Retry-After para mostrar quanto tempo aguardar
    const block429 = src.match(/status\s*===\s*429[\s\S]{0,400}/)?.[0] ?? ''
    expect(block429).toMatch(/Retry-After|retry.after|retryAfter/i)
  })

  it('mensagem 429 informa tempo de espera ao usuario', () => {
    const block429 = src.match(/429[\s\S]{0,400}throw/)?.[0]
      || src.match(/429[\s\S]{0,400}error/i)?.[0]
      || ''
    expect(block429).toMatch(/limite|Retry-After|aguarde|espere/i)
  })
})

// ---------------------------------------------------------------------------
// 5a. Sync 503 -- Meta indisponivel
// ---------------------------------------------------------------------------

describe('Sync 503 -- Meta indisponivel', () => {
  it('captura status 503 explicitamente', () => {
    expect(src).toContain('503')
  })

  it('mensagem 503 menciona Meta e indisponibilidade', () => {
    const block503 = src.match(/status\s*===\s*503[\s\S]{0,300}/)?.[0] ?? ''
    expect(block503).toMatch(/Meta indisponivel|indisponivel/i)
  })
})

// ---------------------------------------------------------------------------
// 5b. Sync 500 -- erro interno generico
// ---------------------------------------------------------------------------

describe('Sync 500 -- erro interno do servidor', () => {
  it('captura status 500 explicitamente', () => {
    expect(src).toContain('500')
  })

  it('mensagem 500 menciona credenciais e convida a tentar novamente', () => {
    const block500 = src.match(/status\s*===\s*500[\s\S]{0,300}/)?.[0] ?? ''
    expect(block500).toMatch(/credenciais|tente novamente/i)
  })

  it('captura status !r.ok para erros nao mapeados (fallback generico)', () => {
    // Fallback generico para qualquer status nao coberto pelos cases acima
    expect(src).toMatch(/!r\.ok|r\.status\s*[>!=]/)
  })

  it('mensagem de fallback e amigavel (sem jargao tecnico)', () => {
    // "Tente novamente" ou similar -- nao expoe stack trace
    expect(src).toMatch(/tente novamente|tente de novo|indisponivel|indisponivel/i)
  })

  it('exibe opcao de tentar novamente apos erro de sync', () => {
    // Botao ou link "Tentar novamente" no estado de erro
    expect(src).toMatch(/tentar novamente|tente novamente/i)
  })
})

// ---------------------------------------------------------------------------
// 6. Botao sincronizar -- disabled durante operação (previne duplo clique)
// ---------------------------------------------------------------------------

describe('Botao "Sincronizar templates" -- estado disabled', () => {
  it('tem atributo disabled que depende de estado de carregamento', () => {
    // disabled={syncing || ...} previne multiplos cliques simultaneos
    expect(src).toMatch(/disabled=\{.*syncing/)
  })

  it('exibe indicador visual (spinner/texto) durante sync', () => {
    // Loader2 ou texto "Sincronizando" enquanto a requisição esta em curso
    expect(src).toMatch(/Sincronizando|animate-spin|Loader2/)
  })

  it('botao mostra texto diferente durante sync vs em repouso', () => {
    // Texto alternado: "Sincronizar templates" vs "Sincronizando..."
    expect(src).toContain('Sincronizar templates')
    expect(src).toMatch(/Sincronizando|sincronizando/)
  })
})

// ---------------------------------------------------------------------------
// 7. selectedChannelId alimenta as requisições de sync e listagem
// ---------------------------------------------------------------------------

describe('selectedChannelId controla o alvo das requisições', () => {
  it('URL de sync usa selectedChannelId dinamico', () => {
    // A requisição POST de sync inclui o channelId na URL
    expect(src).toMatch(/\$\{selectedChannelId\}\/templates\/sync/)
  })

  it('URL de listagem usa selectedChannelId dinamico', () => {
    // A requisição GET de templates inclui o channelId na URL
    expect(src).toMatch(/\$\{selectedChannelId\}\/templates/)
  })

  it('troca de canal chama setSelectedChannelId e reseta pagina', () => {
    // onChange do seletor atualiza o canal e reinicia a paginacao
    expect(src).toContain('setSelectedChannelId')
    expect(src).toContain('setCurrentPage(1)')
  })
})

// ---------------------------------------------------------------------------
// 8. Toast de sucesso -- inclui contagens do resultado do sync
// ---------------------------------------------------------------------------

describe('Feedback de sync bem-sucedido', () => {
  it('exibe toast.success ao sincronizar com sucesso', () => {
    expect(src).toMatch(/toast\.success/)
  })

  it('inclui contagem de created/updated/deactivated no feedback', () => {
    // O resultado { created, updated, deactivated } e apresentado ao usuario
    expect(src).toContain('created')
    expect(src).toContain('updated')
    expect(src).toContain('deactivated')
  })

  it('recarrega lista de templates apos sync bem-sucedido', () => {
    // loadTemplates() e chamado apos sync para refletir mudancas
    expect(src).toMatch(/loadTemplates\(\)/)
  })
})
