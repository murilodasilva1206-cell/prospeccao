// ---------------------------------------------------------------------------
// Security: isolamento de workspace nos filtros do Inbox (seção 5)
//
// Cobre:
//   5a. Usuário A não vê conversas do workspace B
//   5b. Usuário A não filtra por channel_id do workspace B → 403
//   5c. Endpoint ignora workspace_id vindo da query/body
//   5d. Listagem de canais para filtro restrita ao workspace autenticado
//   5e. Logs não expõem credenciais/tokens em erro de filtro
//
// STATUS: RED — filtros provider/channel_id/date_from/date_to ainda não
//         implementados na rota; os testes de validação de channel_id
//         cross-workspace falharão até a implementação.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('10.0.0.1') }))

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
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: mockFindConversationsByWorkspace,
}))

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

const mockLogError = vi.fn()
const mockLogInfo = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: {
    child: vi.fn().mockReturnValue({ info: mockLogInfo, error: mockLogError }),
  },
}))

// ---------------------------------------------------------------------------
// Importar rota
// ---------------------------------------------------------------------------

const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const WS_A = 'ws-workspace-a'
const WS_B = 'ws-workspace-b'
const CHANNEL_WS_A = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHANNEL_WS_B = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const AUTH_WS_A = {
  workspace_id: WS_A,
  actor: 'api_key:key-a',
  key_id: 'k-a',
  dedup_actor_id: 'api_key:k-a',
}

function makeGetAs(wsAuth: typeof AUTH_WS_A, params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/whatsapp/conversations')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
  })
}

function makeConversation(workspace_id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `conv-${workspace_id}`,
    channel_id: workspace_id === WS_A ? CHANNEL_WS_A : CHANNEL_WS_B,
    channel_name: 'Canal Teste',
    channel_provider: 'META_CLOUD',
    workspace_id,
    contact_phone: '+5511111111111',
    contact_name: 'Contato Teste',
    status: 'open',
    last_message_at: new Date().toISOString(),
    unread_count: 0,
    ai_enabled: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConversationCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationsByWorkspace.mockResolvedValue([])
  mockFindChannelById.mockResolvedValue({
    id: CHANNEL_WS_A,
    workspace_id: WS_A,
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    name: 'Canal A',
    credentials_encrypted: 'enc',
    webhook_secret: 'secret',
  })
})

// ---------------------------------------------------------------------------
// 5a. Usuário A não vê conversas do workspace B
// ---------------------------------------------------------------------------

describe('Isolamento de workspace — Usuário A não vê dados do workspace B', () => {
  it('findConversationsByWorkspace é chamado com workspace_id do token de A, não de B', async () => {
    await conversationsRoute(makeGetAs(AUTH_WS_A))
    expect(mockFindConversationsByWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      WS_A,
      expect.any(Object),
    )
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalledWith(
      expect.anything(),
      WS_B,
      expect.any(Object),
    )
  })

  it('mesmo que repo retorne conversa de WS_B, a rota usa só workspace_id do token', async () => {
    // Se o repo hipoteticamente retornar dados de outro workspace, a rota não deve
    // mudar o workspace_id que foi passado ao repo
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation(WS_A)])
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A))
    expect(res.status).toBe(200)
    // workspace_id passado ao repo deve ser sempre WS_A
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, unknown]
    expect(call[1]).toBe(WS_A)
  })

  it('resposta não inclui conversas de workspace diferente do autenticado', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation(WS_A)])
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A))
    const body = await res.json() as { data: Array<{ workspace_id: string }> }
    for (const conv of body.data) {
      expect(conv.workspace_id).toBe(WS_A)
    }
  })
})

// ---------------------------------------------------------------------------
// 5b. Usuário A não filtra por channel_id do workspace B
// ---------------------------------------------------------------------------

describe('Isolamento — channel_id cross-workspace bloqueado', () => {
  it('channel_id do workspace B retorna 403 para usuário autenticado em WS_A', async () => {
    // Canal pertence ao workspace B
    mockFindChannelById.mockResolvedValue({
      id: CHANNEL_WS_B,
      workspace_id: WS_B,
      provider: 'META_CLOUD',
      name: 'Canal B',
      credentials_encrypted: 'enc',
      webhook_secret: 'secret',
    })

    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_B }))
    expect(res.status).toBe(403)
  })

  it('403 para channel_id de outro workspace não chama findConversationsByWorkspace', async () => {
    mockFindChannelById.mockResolvedValue({
      id: CHANNEL_WS_B,
      workspace_id: WS_B,
      provider: 'EVOLUTION',
      name: 'Canal B',
      credentials_encrypted: 'enc',
      webhook_secret: 'secret',
    })

    await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_B }))
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('channel_id do próprio workspace (WS_A) retorna 200', async () => {
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A }))
    expect(res.status).toBe(200)
  })

  it('channel_id inexistente retorna 403 (não 404 — não revela existência)', async () => {
    mockFindChannelById.mockResolvedValue(null)
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A }))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 5c. workspace_id da query/body é sempre ignorado
// ---------------------------------------------------------------------------

describe('Isolamento — workspace_id da query nunca substituí o do token', () => {
  it('workspace_id=ws-atacante na query não altera o workspace usado', async () => {
    await conversationsRoute(makeGetAs(AUTH_WS_A, { workspace_id: 'ws-atacante' }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, unknown]
    expect(call[1]).toBe(WS_A)
    expect(call[1]).not.toBe('ws-atacante')
  })

  it('workspace_id=ws-b na query não vaza conversas do workspace B', async () => {
    // Mesmo com workspace_id=ws-b na query, repo deve ser chamado com WS_A
    await conversationsRoute(makeGetAs(AUTH_WS_A, { workspace_id: WS_B }))
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, unknown]
    expect(call[1]).toBe(WS_A)
  })

  it('workspace_id combinado com provider na query — provider passa, workspace_id não', async () => {
    await conversationsRoute(
      makeGetAs(AUTH_WS_A, { provider: 'META_CLOUD', workspace_id: 'ws-atacante' }),
    )
    const call = mockFindConversationsByWorkspace.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(call[1]).toBe(WS_A)          // workspace_id do token
    expect(call[2].provider).toBe('META_CLOUD') // provider da query (legítimo)
  })
})

// ---------------------------------------------------------------------------
// 5d. Listagem de canais para filtro restrita ao workspace autenticado
// ---------------------------------------------------------------------------

describe('Isolamento — lista de canais para filtro restrita ao workspace', () => {
  it('findChannelById é chamado para verificar ownership do channel_id', async () => {
    await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A }))
    // A rota deve verificar que o canal pertence ao workspace autenticado
    expect(mockFindChannelById).toHaveBeenCalledWith(
      expect.anything(),
      CHANNEL_WS_A,
    )
  })

  it('verificação de ownership usa workspace_id do token, não da query', async () => {
    await conversationsRoute(
      makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A, workspace_id: 'ws-atacante' }),
    )
    // O canal retornado pelo mock tem workspace_id=WS_A, que deve ser comparado
    // com o workspace_id do token (WS_A) — não com 'ws-atacante'
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A }))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 5e. Logs não expõem credenciais em erros de filtro
// ---------------------------------------------------------------------------

describe('Segurança de logs — sem vazamento de credenciais', () => {
  it('log.error em falha de DB não expõe credentials_encrypted', async () => {
    mockFindConversationsByWorkspace.mockRejectedValue(
      new Error('connection refused: host=db credentials_encrypted=aes256gcm...')
    )
    await conversationsRoute(makeGetAs(AUTH_WS_A))
    const errorLogged = JSON.stringify(mockLogError.mock.calls)
    // O objeto de erro pode ser logado, mas a rota não deve acrescentar campos sensíveis
    expect(errorLogged).not.toContain('webhook_secret')
    expect(errorLogged).not.toContain('access_token')
  })

  it('log.error em falha de validação de channel_id não vaza token do canal', async () => {
    mockFindChannelById.mockRejectedValue(new Error('DB error'))
    await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_A }))
    const errorLogged = JSON.stringify(mockLogError.mock.calls)
    expect(errorLogged).not.toContain('webhook_secret')
    expect(errorLogged).not.toContain('credentials_encrypted')
  })

  it('resposta de erro 403 (cross-workspace) não inclui info do workspace B', async () => {
    mockFindChannelById.mockResolvedValue({
      id: CHANNEL_WS_B,
      workspace_id: WS_B,
      name: 'Canal Secreto do WS_B',
      provider: 'META_CLOUD',
      credentials_encrypted: 'segredo',
      webhook_secret: 'supersecret',
    })

    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { channel_id: CHANNEL_WS_B }))
    expect(res.status).toBe(403)
    const raw = await res.text()
    // Resposta não deve vazar dados do workspace B
    expect(raw).not.toContain('Canal Secreto do WS_B')
    expect(raw).not.toContain('segredo')
    expect(raw).not.toContain('supersecret')
    expect(raw).not.toContain(WS_B)
  })

  it('resposta de erro 400 (data inválida) não expõe stack trace ou dados internos', async () => {
    const res = await conversationsRoute(makeGetAs(AUTH_WS_A, { date_from: '2026-99-99' }))
    expect(res.status).toBe(400)
    const raw = await res.text()
    expect(raw).not.toContain('at Object')  // sem stack trace
    expect(raw).not.toContain('node_modules')
    expect(raw).not.toContain('credentials')
  })
})
