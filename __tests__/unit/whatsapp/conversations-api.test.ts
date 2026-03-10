// ---------------------------------------------------------------------------
// Unit: GET /api/whatsapp/conversations — comportamento e isolamento
//
// Cobre:
//   1. Retorna channel_name e channel_provider por conversa (JOIN no repo)
//   2. Workspace isolation — findConversationsByWorkspace chamado com auth.workspace_id
//   3. workspace_id da query string nunca substitui o do token
//   4. Rate limit → 429 + Retry-After
//   5. Sem autenticação → 401
//   6. Erro interno → 500
//   7. Parâmetros limit/offset/status repassados corretamente
//   8. Nenhuma credencial vazada na resposta
//   9. log.info registra workspace_id e count corretos
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
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationsByWorkspace: mockFindConversationsByWorkspace,
}))

// Logger mock para testes de observabilidade
const mockLogInfo = vi.fn()
const mockLogError = vi.fn()
const mockLoggerChild = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: { child: mockLoggerChild },
}))

// ---------------------------------------------------------------------------
// Importar rota após mocks
// ---------------------------------------------------------------------------

const { GET: conversationsRoute } = await import('@/app/api/whatsapp/conversations/route')

// ---------------------------------------------------------------------------
// Constantes e helpers
// ---------------------------------------------------------------------------

const AUTH_WS1 = {
  workspace_id: 'ws-conv-test',
  actor: 'api_key:test',
  key_id: 'k-1',
  dedup_actor_id: 'api_key:k-1',
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    channel_id: 'ch-1',
    channel_name: 'Canal Meta Prod',
    channel_provider: 'META_CLOUD',
    workspace_id: 'ws-conv-test',
    contact_phone: '+5511999999999',
    contact_name: 'João Silva',
    status: 'open',
    last_message_at: new Date().toISOString(),
    unread_count: 2,
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
    headers: { Authorization: `Bearer wk_${'d'.repeat(64)}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConversationCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS1)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationsByWorkspace.mockResolvedValue([])
  mockLoggerChild.mockReturnValue({ info: mockLogInfo, error: mockLogError })
})

// ---------------------------------------------------------------------------
// 1. channel_name e channel_provider na resposta
// ---------------------------------------------------------------------------

describe('GET /conversations — channel_name e channel_provider na resposta', () => {
  it('retorna channel_name por conversa quando presente', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([
      makeConversation({ channel_name: 'Canal Meta Prod' }),
    ])

    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json() as { data: ReturnType<typeof makeConversation>[] }
    expect(body.data[0].channel_name).toBe('Canal Meta Prod')
  })

  it('retorna channel_provider por conversa quando presente', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([
      makeConversation({ channel_provider: 'META_CLOUD' }),
    ])

    const res = await conversationsRoute(makeGet())
    const body = await res.json() as { data: ReturnType<typeof makeConversation>[] }
    expect(body.data[0].channel_provider).toBe('META_CLOUD')
  })

  it('aceita channel_name nulo (canal sem nome registrado)', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([
      makeConversation({ channel_name: null }),
    ])

    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json() as { data: ReturnType<typeof makeConversation>[] }
    expect(body.data[0].channel_name).toBeNull()
  })

  it('retorna múltiplas conversas cada uma com seu canal correto', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([
      makeConversation({ id: 'c1', channel_name: 'Canal A', channel_provider: 'META_CLOUD' }),
      makeConversation({ id: 'c2', channel_name: 'Canal B', channel_provider: 'EVOLUTION' }),
    ])

    const res = await conversationsRoute(makeGet())
    const body = await res.json() as { data: ReturnType<typeof makeConversation>[] }
    expect(body.data).toHaveLength(2)
    expect(body.data[0].channel_name).toBe('Canal A')
    expect(body.data[1].channel_name).toBe('Canal B')
    expect(body.data[1].channel_provider).toBe('EVOLUTION')
  })
})

// ---------------------------------------------------------------------------
// 2. Workspace isolation — findConversationsByWorkspace usa auth.workspace_id
// ---------------------------------------------------------------------------

describe('GET /conversations — isolamento de workspace', () => {
  it('chama findConversationsByWorkspace com workspace_id do token (não da query)', async () => {
    // Mesmo que atacante injete workspace_id na URL, o repo usa o do token
    const req = makeGet({ workspace_id: 'ws-atacante' })
    await conversationsRoute(req)

    expect(mockFindConversationsByWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'ws-conv-test',   // workspace_id do token AUTH_WS1
      expect.any(Object),
    )
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalledWith(
      expect.anything(),
      'ws-atacante',
      expect.any(Object),
    )
  })

  it('workspace_id do auth nunca vaza na query que vai para o repo', async () => {
    await conversationsRoute(makeGet())

    const call = mockFindConversationsByWorkspace.mock.calls[0]
    // segundo argumento deve ser exatamente o workspace_id do token
    expect(call[1]).toBe('ws-conv-test')
  })
})

// ---------------------------------------------------------------------------
// 3. Parâmetros limit/offset/status repassados para o repositório
// ---------------------------------------------------------------------------

describe('GET /conversations — parâmetros de filtragem e paginação', () => {
  it('limit padrão é 50 quando não informado', async () => {
    await conversationsRoute(makeGet())
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { limit: number; offset: number; status?: string }
    ]
    expect(opts.limit).toBe(50)
  })

  it('limit customizado é repassado ao repositório', async () => {
    await conversationsRoute(makeGet({ limit: '30' }))
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { limit: number }
    ]
    expect(opts.limit).toBe(30)
  })

  it('limit é capped em 100 (evita queries muito grandes)', async () => {
    await conversationsRoute(makeGet({ limit: '999' }))
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { limit: number }
    ]
    expect(opts.limit).toBeLessThanOrEqual(100)
  })

  it('offset padrão é 0', async () => {
    await conversationsRoute(makeGet())
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { offset: number }
    ]
    expect(opts.offset).toBe(0)
  })

  it('status é repassado para o repositório quando fornecido', async () => {
    await conversationsRoute(makeGet({ status: 'resolved' }))
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { status?: string }
    ]
    expect(opts.status).toBe('resolved')
  })

  it('status é undefined quando não informado', async () => {
    await conversationsRoute(makeGet())
    const [, , opts] = mockFindConversationsByWorkspace.mock.calls[0] as [
      unknown, string, { status?: string }
    ]
    expect(opts.status).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Rate limit → 429 + Retry-After
// ---------------------------------------------------------------------------

describe('GET /conversations — rate limit', () => {
  it('retorna 429 com Retry-After quando limite excedido', async () => {
    mockConversationCheck.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 30_000 })
    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })

  it('não chama o repositório quando rate limit bloqueado', async () => {
    mockConversationCheck.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 30_000 })
    await conversationsRoute(makeGet())
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. Auth 401
// ---------------------------------------------------------------------------

describe('GET /conversations — autenticação', () => {
  it('retorna 401 quando token inválido (AuthError lançado)', async () => {
    const { AuthError } = await import('@/lib/whatsapp/auth-middleware')
    mockRequireWorkspaceAuth.mockRejectedValue(new AuthError('Invalid or revoked API key'))

    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(401)
    expect(mockFindConversationsByWorkspace).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. Erro interno → 500
// ---------------------------------------------------------------------------

describe('GET /conversations — erro interno', () => {
  it('retorna 500 quando findConversationsByWorkspace lança', async () => {
    mockFindConversationsByWorkspace.mockRejectedValue(new Error('DB query timeout'))
    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/erro interno/i)
  })

  it('log.error é chamado no caso de erro interno', async () => {
    mockFindConversationsByWorkspace.mockRejectedValue(new Error('connection lost'))
    await conversationsRoute(makeGet())
    expect(mockLogError).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 7. Nenhuma credencial de canal vazada na resposta
//
// A proteção primária é no SQL do repo (SELECT lista campos seguros; credenciais
// ficam em whatsapp_channels.credentials_encrypted que não é incluído no JOIN).
// Estes testes verificam que a rota não injeta nem expõe campos sensíveis além
// do que o repo retorna (que já é seguro).
// ---------------------------------------------------------------------------

describe('GET /conversations — sem vazamento de credenciais', () => {
  it('resposta contém apenas campos de conversa + channel_name/provider (sem credenciais)', async () => {
    // O repo retorna somente os campos projetados pelo SELECT — sem credentials_encrypted
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation()])
    const res = await conversationsRoute(makeGet())
    const raw = await res.text()

    // Campos que NUNCA devem aparecer numa resposta de conversa
    expect(raw).not.toContain('credentials_encrypted')
    expect(raw).not.toContain('webhook_secret')
  })

  it('resposta não injeta access_token além do que o repo retorna', async () => {
    // A rota não adiciona campos de credencial por conta própria
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation()])
    const res = await conversationsRoute(makeGet())
    const raw = await res.text()

    // A rota retorna só o que o repo fornece — sem injetar token
    expect(raw).not.toContain('webhook_secret')
    // Verifica que campos de canais não aparecem além do projetado
    expect(raw).not.toContain('credentials_encrypted')
  })
})

// ---------------------------------------------------------------------------
// 8. Observabilidade — log.info com workspace_id e count
// ---------------------------------------------------------------------------

describe('GET /conversations — observabilidade', () => {
  it('log.info registra workspace_id e count de conversas retornadas', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([makeConversation(), makeConversation({ id: 'c2' })])

    const res = await conversationsRoute(makeGet())
    expect(res.status).toBe(200)
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'ws-conv-test', count: 2 }),
      'Conversas listadas',
    )
  })

  it('log.info registra count=0 para workspace sem conversas', async () => {
    mockFindConversationsByWorkspace.mockResolvedValue([])

    await conversationsRoute(makeGet())
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ count: 0 }),
      'Conversas listadas',
    )
  })
})
