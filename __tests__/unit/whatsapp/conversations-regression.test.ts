// ---------------------------------------------------------------------------
// Regressão funcional + Performance: filtros do Inbox (seções 6 e 7)
//
// Cobre:
//   6a. Busca por texto no ConversationList continua funcionando
//   6b. Badge de canal (channel_name/provider) continua renderizando
//   6c. Seleção de conversa mantém thread correta após refetch filtrado
//   6d. patchConversation (status/IA) continua funcionando com filtros ativos
//   7a. limit máximo continua respeitado (cap 100)
//   7b. Filtros não enviam params extras quando não definidos (querystring limpa)
//   7c. Smoke de tempo: endpoint de filtro não demora mais que um threshold razoável
//
// Estratégia mista:
//   - Análise estática para regressões de UI (ConversationList.tsx)
//   - Testes de rota para comportamento de paginação e patchConversation
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Source para análise estática
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '../../..')
const listSrc = (() => {
  try {
    return readFileSync(resolve(ROOT, 'app/whatsapp/inbox/components/ConversationList.tsx'), 'utf-8')
  } catch {
    return ''
  }
})()
const hookSrc = (() => {
  try {
    return readFileSync(resolve(ROOT, 'app/whatsapp/inbox/hooks/useConversations.ts'), 'utf-8')
  } catch {
    return ''
  }
})()

// ---------------------------------------------------------------------------
// Mocks para testes de rota
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockConversationCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappConversationLimiter: { check: mockConversationCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationsByWorkspace = vi.fn()
const mockUpdateConversationStatus = vi.fn()
const mockUpdateConversationAiEnabled = vi.fn()
const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: mockFindConversationsByWorkspace,
  updateConversationStatus: mockUpdateConversationStatus,
  updateConversationAiEnabled: mockUpdateConversationAiEnabled,
  findConversationById: mockFindConversationById,
  markAllRead: vi.fn(),
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }) },
}))

const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')
const { PATCH: patchRoute } = await import('@/app/api/whatsapp/conversations/[id]/route')

const AUTH_WS = {
  workspace_id: 'ws-regression',
  actor: 'api_key:test',
  key_id: 'k-reg',
  dedup_actor_id: 'api_key:k-reg',
}

const CHANNEL_UUID = 'cccc3333-cccc-4ccc-8ccc-cccccccccccc'

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-reg-1',
    channel_id: CHANNEL_UUID,
    channel_name: 'Canal Regressão',
    channel_provider: 'META_CLOUD',
    workspace_id: 'ws-regression',
    contact_phone: '+5511999990000',
    contact_name: 'Regressão Teste',
    status: 'open',
    last_message_at: new Date().toISOString(),
    unread_count: 1,
    ai_enabled: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeGet(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/whatsapp/conversations')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'r'.repeat(64)}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConversationCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationsByWorkspace.mockResolvedValue([])
  mockFindChannelById.mockResolvedValue({
    id: CHANNEL_UUID,
    workspace_id: 'ws-regression',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    name: 'Canal Regressão',
    credentials_encrypted: 'enc',
    webhook_secret: 'secret',
  })
})

// ---------------------------------------------------------------------------
// 6a. Busca por texto no ConversationList continua funcionando
// ---------------------------------------------------------------------------

describe('Regressão — busca por texto no ConversationList', () => {
  it('ConversationList ainda tem input de busca (search)', () => {
    expect(listSrc).toMatch(/type=['"]search['"]|placeholder.*Buscar|search.*input/i)
  })

  it('estado search ainda filtra conversations por contact_name/phone', () => {
    expect(listSrc).toMatch(/contact_name.*search|search.*contact_name|toLowerCase.*includes/i)
  })

  it('busca de texto é case-insensitive', () => {
    expect(listSrc).toMatch(/toLowerCase\(\)/)
  })

  it('busca funciona mesmo quando filtros de provider/data estão ativos', () => {
    // O filtro de texto (client-side) deve aplicar SOBRE as conversas já filtradas pelo servidor
    // O hook recebe as conversas filtradas e o componente aplica a busca de texto local
    expect(listSrc).toMatch(/filter\(|\.filter/)
  })
})

// ---------------------------------------------------------------------------
// 6b. Badge de canal (channel_name / provider) continua renderizando
// ---------------------------------------------------------------------------

describe('Regressão — badge de canal renderizado com filtros', () => {
  it('ConversationList ainda exibe channel_name', () => {
    expect(listSrc).toContain('channel_name')
  })

  it('ConversationList ainda exibe channel_provider', () => {
    expect(listSrc).toContain('channel_provider')
  })

  it('badge META_CLOUD ainda usa classe de cor azul', () => {
    expect(listSrc).toMatch(/META_CLOUD[\s\S]{0,200}blue|blue[\s\S]{0,200}META_CLOUD/)
  })

  it('badge EVOLUTION ainda usa classe de cor verde', () => {
    expect(listSrc).toMatch(/EVOLUTION[\s\S]{0,200}emerald|green|emerald[\s\S]{0,200}EVOLUTION/)
  })

  it('API retorna channel_name e channel_provider com filtros ativos', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([
      makeConversation({ channel_name: 'Canal Meta', channel_provider: 'META_CLOUD' }),
    ])
    const res = await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ channel_name: string; channel_provider: string }> }
    expect(body.data[0].channel_name).toBe('Canal Meta')
    expect(body.data[0].channel_provider).toBe('META_CLOUD')
  })
})

// ---------------------------------------------------------------------------
// 6c. Seleção de conversa mantém thread após refetch filtrado
// ---------------------------------------------------------------------------

describe('Regressão — seleção de conversa mantém thread', () => {
  it('API retorna id da conversa em todas as respostas (mesmo com filtros)', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation({ id: 'conv-abc' })])
    const res = await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data[0].id).toBe('conv-abc')
  })

  it('hook expõe função refetch que pode ser chamada após seleção de conversa', () => {
    expect(hookSrc).toContain('refetch')
  })

  it('ConversationList aceita selectedId para manter seleção visual', () => {
    expect(listSrc).toContain('selectedId')
  })

  it('conversa selecionada mantém bordas de destaque mesmo após refetch', () => {
    // bg-green-50 / border-l-4 border-l-green-500 indicam a conversa selecionada
    expect(listSrc).toMatch(/selectedId.*conv\.id|conv\.id.*selectedId/)
    expect(listSrc).toMatch(/bg-green-50|border-l-green/)
  })
})

// ---------------------------------------------------------------------------
// 6d. patchConversation continua funcionando com filtros ativos
// ---------------------------------------------------------------------------

describe('Regressão — patchConversation funciona com filtros', () => {
  it('PATCH /conversations/:id atualiza status independente de filtros na listagem', async () => {
    const conv = makeConversation({ id: 'conv-patch-test' })
    mockFindConversationById.mockResolvedValue(conv)
    mockUpdateConversationStatus.mockResolvedValue({ ...conv, status: 'resolved' })

    const req = new NextRequest(
      'http://localhost/api/whatsapp/conversations/conv-patch-test',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer wk_${'p'.repeat(64)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'resolved' }),
      },
    )

    const res = await patchRoute(req, { params: Promise.resolve({ id: 'conv-patch-test' }) })
    expect(res.status).toBe(200)
  })

  it('PATCH com ai_enabled funciona independente de filtros na listagem', async () => {
    const conv = makeConversation({ id: 'conv-ai-test' })
    mockFindConversationById.mockResolvedValue(conv)
    mockUpdateConversationAiEnabled.mockResolvedValue({ ...conv, ai_enabled: true })

    const req = new NextRequest(
      'http://localhost/api/whatsapp/conversations/conv-ai-test',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer wk_${'p'.repeat(64)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ai_enabled: true }),
      },
    )

    const res = await patchRoute(req, { params: Promise.resolve({ id: 'conv-ai-test' }) })
    expect(res.status).toBe(200)
  })

  it('hook expõe patchConversation independente dos filtros aplicados', () => {
    expect(hookSrc).toContain('patchConversation')
  })
})

// ---------------------------------------------------------------------------
// 7a. limit máximo continua respeitado com filtros
// ---------------------------------------------------------------------------

describe('Performance — limit máximo respeitado', () => {
  it('limit=999 com provider filter é capped em 100', async () => {
    await conversationsRoute(makeGet({ limit: '999', provider: 'EVOLUTION' }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, { limit: number }]
    expect(call[2].limit).toBeLessThanOrEqual(100)
  })

  it('limit=999 com channel_id filter é capped em 100', async () => {
    await conversationsRoute(makeGet({ limit: '999', channel_id: CHANNEL_UUID }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, { limit: number }]
    expect(call[2].limit).toBeLessThanOrEqual(100)
  })

  it('limit=999 com date range filter é capped em 100', async () => {
    await conversationsRoute(makeGet({ limit: '999', date_from: '2026-03-01', date_to: '2026-03-10' }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, { limit: number }]
    expect(call[2].limit).toBeLessThanOrEqual(100)
  })
})

// ---------------------------------------------------------------------------
// 7b. Querystring limpa: sem params extras quando filtros ausentes
// ---------------------------------------------------------------------------

describe('Performance — querystring limpa sem filtros', () => {
  it('sem filtros: hook não adiciona params vazios à URL (análise estática)', () => {
    // O hook deve usar condicionais para não enviar params undefined/null
    // Qualquer params.set deve ter um guard condicional
    // Verifica que não há params.set incondicional para os novos campos
    const unconditionalSets = hookSrc
      .split('\n')
      .filter((line) => line.match(/params\.set.*provider|params\.set.*channel_id|params\.set.*date_from|params\.set.*date_to|params\.set.*preset/))
      .filter((line) => !line.match(/if\s*\(|&&|\?\?/))

    // Máximo 0 linhas com params.set incondicional para os novos filtros
    expect(unconditionalSets.length).toBe(0)
  })

  it('sem filtros: API não recebe params extras (verificação de chamada ao repo)', async () => {
    await conversationsRoute(makeGet())
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, Record<string, unknown>]
    const opts = call[2]
    // Campos de filtro não devem ser enviados como undefined explícito
    // (podem estar ausentes do objeto ou serem undefined)
    const hasExplicitUndefined = Object.entries(opts).some(
      ([k, v]) => ['provider', 'channel_id', 'date_from', 'date_to'].includes(k) && v === undefined,
    )
    // undefined explícito no objeto é OK, mas null não deve ser enviado como filtro
    const hasNull = Object.entries(opts).some(
      ([k, v]) => ['provider', 'channel_id', 'date_from', 'date_to'].includes(k) && v === null,
    )
    expect(hasNull).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7c. Smoke de tempo: endpoint responde dentro de threshold razoável
// ---------------------------------------------------------------------------

describe('Performance — smoke de tempo de resposta', () => {
  it('endpoint com provider filter responde em < 500ms (mock de DB)', async () => {
    // Com mocks não há I/O real; o overhead deve ser mínimo
    const start = Date.now()
    await conversationsRoute(makeGet({ provider: 'META_CLOUD' }))
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  it('endpoint com combinação completa de filtros responde em < 500ms (mock de DB)', async () => {
    const start = Date.now()
    await conversationsRoute(makeGet({
      provider: 'EVOLUTION',
      channel_id: CHANNEL_UUID,
      date_from: '2026-03-01',
      date_to: '2026-03-10',
      status: 'open',
      limit: '50',
      offset: '0',
    }))
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })
})
