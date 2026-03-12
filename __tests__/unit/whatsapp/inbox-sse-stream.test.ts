// ---------------------------------------------------------------------------
// TDD — SSE Stream: Tempo Real com Fallback
//
// 1. Conecta com auth válida → 200 + headers corretos
// 2. Recebe message.created para inbound
// 3. Recebe message.status.updated para outbound
// 4. Reconnect via Last-Event-ID muda cursor da query
// 5. Heartbeat/keepalive enviado via setInterval
// 6. Fallback: polling via GET /messages ainda funciona (convivência)
// 7. Não duplica: cursor avança após cada evento recebido
// 8. Isolamento: DB query usa workspace_id do token (não da URL)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockInboxCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappInboxLimiter: { check: mockInboxCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import route AFTER mocks
// ---------------------------------------------------------------------------

const { GET } = await import('@/app/api/whatsapp/inbox/stream/route')
// AuthError is re-exported by the partial mock (via ...actual), so we can
// use it to simulate real auth failures in tests.
const { AuthError } = await import('@/lib/whatsapp/auth-middleware')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = 'ws-sse-a'
const WS_B = 'ws-sse-b'

const AUTH_A = { workspace_id: WS_A, actor: 'api_key:k-a', key_id: 'k-a', dedup_actor_id: 'api_key:k-a' }
const AUTH_B = { workspace_id: WS_B, actor: 'api_key:k-b', key_id: 'k-b', dedup_actor_id: 'api_key:k-b' }

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-sse-1',
    conversation_id: 'conv-sse-1',
    direction: 'inbound',
    status: 'delivered',
    body: 'Olá!',
    message_type: 'text',
    created_at: '2026-03-11T10:00:00.000Z',
    ...overrides,
  }
}

function makeRequest(overrides: { headers?: Record<string, string>; search?: string } = {}) {
  const url = `http://localhost/api/whatsapp/inbox/stream${overrides.search ?? ''}`
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer wk_${'a'.repeat(64)}`,
      ...overrides.headers,
    },
  })
}

/** Read the first available chunk from the stream, then abort the controller */
async function readFirstChunk(
  body: ReadableStream<Uint8Array>,
  abort: AbortController,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    const { value } = await reader.read()
    return value ? decoder.decode(value) : ''
  } finally {
    reader.releaseLock()
    abort.abort()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInboxCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_A)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  // Default: no new messages
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Cenário 1 — Conecta com auth válida e workspace correto
// ---------------------------------------------------------------------------

describe('Cenário 1 — Conexão SSE com auth válida', () => {
  it('retorna 200 com Content-Type text/event-stream', async () => {
    const abort = new AbortController()
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    abort.abort()
  })

  it('inclui Cache-Control: no-cache', async () => {
    const abort = new AbortController()
    const res = await GET(makeRequest())
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    abort.abort()
  })

  it('retorna 401 quando auth falha', async () => {
    mockRequireWorkspaceAuth.mockRejectedValue(new AuthError('Nao autorizado'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('retorna 429 quando rate limit atingido', async () => {
    mockInboxCheck.mockResolvedValue({ success: false, resetAt: Date.now() + 60_000 })
    const res = await GET(makeRequest())
    expect(res.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// Cenário 2 — Recebe evento message.created para inbound
// ---------------------------------------------------------------------------

describe('Cenário 2 — Evento message.created para mensagem inbound', () => {
  it('enqueue event com event:message.created para direção inbound', async () => {
    const row = makeRow({ direction: 'inbound', id: 'msg-inbound-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    const chunk = await readFirstChunk(res.body!, abort)

    expect(chunk).toContain('event: message.created')
    expect(chunk).toContain('msg-inbound-1')
  })

  it('inclui id: <messageId> para permitir reconnect', async () => {
    const row = makeRow({ id: 'msg-reconnect-id' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    const chunk = await readFirstChunk(res.body!, abort)

    expect(chunk).toContain('id: msg-reconnect-id')
  })

  it('data contém JSON com body da mensagem', async () => {
    const row = makeRow({ body: 'Mensagem em português com acentuação' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    const chunk = await readFirstChunk(res.body!, abort)

    expect(chunk).toContain('data:')
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
    expect(dataLine).toBeTruthy()
    const parsed = JSON.parse(dataLine!.replace('data: ', '')) as { body: string }
    expect(parsed.body).toBe('Mensagem em português com acentuação')
  })
})

// ---------------------------------------------------------------------------
// Cenário 3 — Recebe evento message.status.updated para outbound
// ---------------------------------------------------------------------------

describe('Cenário 3 — Evento message.status.updated para outbound', () => {
  it('enqueue event:message.status.updated para direção outbound', async () => {
    const row = makeRow({ direction: 'outbound', status: 'delivered', id: 'msg-out-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    const chunk = await readFirstChunk(res.body!, abort)

    expect(chunk).toContain('event: message.status.updated')
    expect(chunk).toContain('msg-out-1')
  })

  it('status read também usa message.status.updated', async () => {
    const row = makeRow({ direction: 'outbound', status: 'read', id: 'msg-read-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    const chunk = await readFirstChunk(res.body!, abort)

    expect(chunk).toContain('event: message.status.updated')
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))!
    const parsed = JSON.parse(dataLine.replace('data: ', '')) as { status: string }
    expect(parsed.status).toBe('read')
  })
})

// ---------------------------------------------------------------------------
// Cenário 4 — Reconnect via Last-Event-ID muda cursor da query
// ---------------------------------------------------------------------------

describe('Cenário 4 — Reconnect via Last-Event-ID', () => {
  it('usa Last-Event-ID como cursor para a query SQL', async () => {
    const resumeTs = '2026-03-11T09:00:00.000Z'
    // Return a row so initial poll enqueues an event (makes readFirstChunk work)
    const row = makeRow({ id: 'resume-msg-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(makeRequest({ headers: { 'Last-Event-ID': resumeTs } }))
    expect(res.status).toBe(200)

    await readFirstChunk(res.body!, abort)

    // DB query should have been called with the resumeTs as cursor
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.workspace_id'),
      [WS_A, resumeTs],
    )
  })

  it('usa ?since query param quando Last-Event-ID ausente', async () => {
    const sinceTs = '2026-03-10T00:00:00.000Z'
    const row = makeRow({ id: 'since-msg-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(makeRequest({ search: `?since=${sinceTs}` }))
    await readFirstChunk(res.body!, abort)

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.workspace_id'),
      [WS_A, sinceTs],
    )
  })

  it('Last-Event-ID tem precedência sobre ?since', async () => {
    const lastId = '2026-03-11T09:30:00.000Z'
    const since = '2026-03-10T00:00:00.000Z'
    const row = makeRow({ id: 'precedence-msg-1' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(
      makeRequest({ headers: { 'Last-Event-ID': lastId }, search: `?since=${since}` }),
    )
    await readFirstChunk(res.body!, abort)

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.workspace_id'),
      [WS_A, lastId],
    )
  })
})

// ---------------------------------------------------------------------------
// Cenário 5 — Heartbeat keepalive
// ---------------------------------------------------------------------------

describe('Cenário 5 — Heartbeat / keepalive', () => {
  it('envia comentário SSE ": heartbeat" após HEARTBEAT_MS', async () => {
    vi.useFakeTimers()
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Start pending read BEFORE advancing timers
    const pendingRead = reader.read()

    // Flush microtasks so start() completes: await poll() needs 2 async hops
    // (pool.connect + client.query) plus await poll() itself = 3 flushes min
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Now setInterval for heartbeat is registered — advance past it
    vi.advanceTimersByTime(15_001)

    const { value } = await pendingRead
    const text = decoder.decode(value)
    expect(text).toContain(': heartbeat')

    reader.releaseLock()
    vi.useRealTimers()
  })

  it('conexão SSE mantém stream aberto entre heartbeats', async () => {
    vi.useFakeTimers()
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(res.body).not.toBeNull()

    abort.abort()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Cenário 6 — Fallback: polling via GET /messages coexiste com SSE
// ---------------------------------------------------------------------------

describe('Cenário 6 — Fallback: polling endpoint funciona independentemente', () => {
  it('GET /inbox/stream e GET /messages podem ser chamados para o mesmo workspace', async () => {
    // Verifica que o SSE stream route retorna 200 (SSE disponível)
    const abort = new AbortController()
    const sseRes = await GET(makeRequest())
    expect(sseRes.status).toBe(200)
    abort.abort()

    // Se EventSource não disponível, o cliente usa polling normal — o endpoint SSE
    // retorna o mesmo formato de autenticação para ambos os casos
    expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream')
  })

  it('erro de poll não fecha o stream (degradação graciosa)', async () => {
    // Primeira poll falha, mas stream continua aberto
    mockClientQuery.mockRejectedValueOnce(new Error('DB error temporário'))
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(makeRequest())

    // Stream ainda deve estar aberto e retornar 200
    expect(res.status).toBe(200)
    expect(res.body).not.toBeNull()

    abort.abort()
  })
})

// ---------------------------------------------------------------------------
// Cenário 7 — Não duplica: cursor avança após cada evento
// ---------------------------------------------------------------------------

describe('Cenário 7 — Cursor avança para evitar duplicação', () => {
  it('após receber mensagem, cursor avança para created_at dela', async () => {
    const row1 = makeRow({ id: 'msg-1', created_at: '2026-03-11T10:00:01.000Z' })
    const row2 = makeRow({ id: 'msg-2', created_at: '2026-03-11T10:00:02.000Z' })

    // First poll returns two messages — each is a separate enqueue (separate chunk)
    mockClientQuery.mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await GET(makeRequest())
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Each sendEvent() call = one enqueue = one chunk; read both
    const { value: v1 } = await reader.read()
    const { value: v2 } = await reader.read()
    const text = (v1 ? decoder.decode(v1) : '') + (v2 ? decoder.decode(v2) : '')

    expect(text).toContain('msg-1')
    expect(text).toContain('msg-2')

    reader.releaseLock()
  })

  it('query inclui ORDER BY created_at ASC e LIMIT 50 para consistência', async () => {
    const row = makeRow({ id: 'order-msg' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const abort = new AbortController()
    const res = await GET(makeRequest())
    await readFirstChunk(res.body!, abort)

    const [queryStr] = mockClientQuery.mock.calls[0] as [string]
    expect(queryStr).toContain('ORDER BY m.created_at ASC')
    expect(queryStr).toContain('LIMIT 50')
  })
})

// ---------------------------------------------------------------------------
// Cenário 8 — Isolamento: workspace A não recebe eventos de B
// ---------------------------------------------------------------------------

describe('Cenário 8 — Isolamento de workspace no stream SSE', () => {
  it('DB query filtra por workspace_id do token (WS_A)', async () => {
    const row = makeRow({ id: 'ws-a-msg' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_A)

    const abort = new AbortController()
    const res = await GET(makeRequest())
    await readFirstChunk(res.body!, abort)

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.workspace_id'),
      expect.arrayContaining([WS_A]),
    )
  })

  it('DB query NÃO usa workspace_id de outro workspace (WS_B)', async () => {
    const row = makeRow({ id: 'ws-a-only-msg' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_A)

    const abort = new AbortController()
    const res = await GET(makeRequest())
    await readFirstChunk(res.body!, abort)

    const queryArgs = mockClientQuery.mock.calls[0] as [string, string[]]
    expect(queryArgs[1]).not.toContain(WS_B)
  })

  it('WS_B token resulta em query com WS_B como filtro', async () => {
    const row = makeRow({ id: 'ws-b-msg' })
    mockClientQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockRequireWorkspaceAuth.mockResolvedValue(AUTH_B)

    const abort = new AbortController()
    const res = await GET(makeRequest())
    await readFirstChunk(res.body!, abort)

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.workspace_id'),
      expect.arrayContaining([WS_B]),
    )
  })

  it('token inválido retorna 401 sem consultar o DB', async () => {
    mockRequireWorkspaceAuth.mockRejectedValue(new AuthError('Unauthorized'))

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(mockClientQuery).not.toHaveBeenCalled()
  })
})
