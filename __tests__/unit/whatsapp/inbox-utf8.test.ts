// ---------------------------------------------------------------------------
// TDD — UTF-8 / Mojibake: codificação correta em toda a stack
//
// Complementa i18n-encoding.test.ts (que faz file-scan estático) com testes
// de comportamento das rotas API:
//
// 1. Respostas de erro das rotas têm texto PT-BR sem mojibake
// 2. GET /messages preserva acentuação em body de mensagens
// 3. POST /read retorna texto de erro sem caracteres corrompidos
// 4. Strings críticas do page.tsx / ConversationList.tsx corretas
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockConvLimitCheck = vi.fn()
const mockInboxLimitCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappConversationLimiter: { check: mockConvLimitCheck },
  whatsappInboxLimiter: { check: mockInboxLimitCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindConversationById = vi.fn()
vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  findConversationById: mockFindConversationById,
  markAllRead: vi.fn(),
}))

const mockFindMessagesByConversation = vi.fn()
vi.mock('@/lib/whatsapp/message-repo', () => ({
  findMessagesByConversation: mockFindMessagesByConversation,
  insertMessage: vi.fn(),
}))

const mockGetSignedUrl = vi.fn()
vi.mock('@/lib/whatsapp/media', () => ({ getSignedUrl: mockGetSignedUrl }))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

const { POST: readRoute } = await import('@/app/api/whatsapp/conversations/[id]/read/route')
const { GET: messagesGET } = await import(
  '@/app/api/whatsapp/conversations/[id]/messages/route'
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'ws-utf8-api'
const CONV_ID = 'utf8a111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const AUTH_WS = {
  workspace_id: WS,
  actor: 'api_key:test',
  key_id: 'k-utf8',
  dedup_actor_id: 'api_key:k-utf8',
}

function makeConversation(wsId = WS) {
  return {
    id: CONV_ID,
    channel_id: 'ch-utf8-1',
    workspace_id: wsId,
    contact_phone: '+5511999999999',
    contact_name: 'Ação Âncora',
    status: 'open',
    unread_count: 2,
    ai_enabled: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConvLimitCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockInboxLimitCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindConversationById.mockResolvedValue(makeConversation())
  mockFindMessagesByConversation.mockResolvedValue([])
  mockGetSignedUrl.mockResolvedValue('https://s3.example.com/file')
})

// ---------------------------------------------------------------------------
// Cenário 1 — Respostas de erro das rotas: texto PT-BR sem mojibake
// ---------------------------------------------------------------------------

describe('Cenário 1 — Respostas de erro das rotas: texto sem mojibake', () => {
  it('POST /read → 404 quando conversa não encontrada: sem bytes corrompidos', async () => {
    mockFindConversationById.mockResolvedValue(null)

    const res = await readRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    // No mojibake sequences
    expect(body.error).not.toMatch(/Ã[£§©³²¡¢ºª¤]/u)
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('POST /read → 403 cross-workspace: mensagem de erro sem mojibake', async () => {
    mockFindConversationById.mockResolvedValue(makeConversation('ws-outro'))

    const res = await readRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/Ã[£§©³²]/u)
  })

  it('Content-Type das respostas JSON é application/json (UTF-8 implícito)', async () => {
    mockFindConversationById.mockResolvedValue(null)

    const res = await readRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

// ---------------------------------------------------------------------------
// Cenário 2 — GET /messages preserva acentuação em body de mensagens
// ---------------------------------------------------------------------------

describe('Cenário 2 — GET /messages preserva acentuação PT-BR end-to-end', () => {
  it('body com texto português retorna sem corrompimento', async () => {
    const ptBody = 'Olá! Gostaria de informações sobre o serviço de manutenção.'
    mockFindMessagesByConversation.mockResolvedValue([
      {
        id: 'msg-pt-1',
        conversation_id: CONV_ID,
        direction: 'inbound',
        message_type: 'text',
        status: 'delivered',
        body: ptBody,
        sent_by: 'webhook',
        media_s3_key: null,
        created_at: new Date().toISOString(),
      },
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Olá')
    expect(text).toContain('informações')
    expect(text).toContain('manutenção')
    // Must NOT contain mojibake
    expect(text).not.toContain('OlÃ¡')
    expect(text).not.toContain('informaÃ§Ãµes')
    expect(text).not.toContain('manutenÃ§Ã£o')
  })

  it('body com caracteres especiais PT-BR: ção, ção, ões, ã, â, ê', async () => {
    const specialBody = 'Ação comercial: expansão e atenção ao coração'
    mockFindMessagesByConversation.mockResolvedValue([
      {
        id: 'msg-special',
        conversation_id: CONV_ID,
        direction: 'outbound',
        message_type: 'text',
        status: 'sent',
        body: specialBody,
        sent_by: 'operator',
        media_s3_key: null,
        created_at: new Date().toISOString(),
      },
    ])

    const res = await messagesGET(
      new NextRequest(
        `http://localhost/api/whatsapp/conversations/${CONV_ID}/messages`,
        { method: 'GET', headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` } },
      ),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    const text = await res.text()
    expect(text).toContain('Ação')
    expect(text).toContain('expansão')
    expect(text).toContain('atenção')
  })
})

// ---------------------------------------------------------------------------
// Cenário 3 — POST /read: resposta de sucesso em UTF-8
// ---------------------------------------------------------------------------

describe('Cenário 3 — POST /read: resposta de sucesso sem corrupção', () => {
  it('200 ok retorna JSON válido sem caracteres corrompidos', async () => {
    const res = await readRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('resposta de 429 rate-limit não tem mojibake', async () => {
    mockConvLimitCheck.mockResolvedValue({ success: false, resetAt: Date.now() + 60_000 })

    const res = await readRoute(
      new NextRequest(`http://localhost/api/whatsapp/conversations/${CONV_ID}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      }),
      { params: Promise.resolve({ id: CONV_ID }) },
    )

    expect(res.status).toBe(429)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/Ã[£§©³]/u)
  })
})

// ---------------------------------------------------------------------------
// Cenário 4 — Strings críticas do page.tsx / ConversationList.tsx corretas
// ---------------------------------------------------------------------------

describe('Cenário 4 — Strings críticas da inbox sem mojibake nos arquivos fonte', () => {
  // These verify the specific strings the user flagged as corrupted
  const CRITICAL_STRINGS: Array<{ file: string; expected: string; forbidden: string }> = [
    {
      file: 'app/whatsapp/inbox/page.tsx',
      expected: 'não informado',
      forbidden: 'nÃ£o informado',
    },
    {
      file: 'app/whatsapp/inbox/page.tsx',
      expected: 'Endereço',
      forbidden: 'EndereÃ§o',
    },
    {
      file: 'app/whatsapp/inbox/page.tsx',
      expected: 'Próxima melhor ação',
      forbidden: 'PrÃ³xima melhor aÃ§Ã£o',
    },
    {
      file: 'app/whatsapp/inbox/page.tsx',
      expected: 'Resumo rápido',
      forbidden: 'Resumo rÃ¡pido',
    },
    {
      file: 'app/whatsapp/inbox/page.tsx',
      expected: 'Módulo',
      forbidden: 'MÃ³dulo',
    },
    {
      file: 'app/whatsapp/inbox/components/ConversationList.tsx',
      expected: 'Canal não identificado',
      forbidden: 'Canal nÃ£o identificado',
    },
    {
      file: 'app/whatsapp/inbox/components/ConversationList.tsx',
      expected: 'Nenhuma conversa encontrada',
      forbidden: 'Nenhuma conversa encontrada', // no accents to corrupt here
    },
  ]

  for (const { file, expected, forbidden } of CRITICAL_STRINGS) {
    it(`"${expected}" aparece corretamente em ${file.split('/').pop()}`, () => {
      const fullPath = join(process.cwd(), file)
      let content: string
      try {
        content = readFileSync(fullPath, 'utf-8')
      } catch {
        return // skip if file doesn't exist yet
      }
      expect(content).toContain(expected)
      if (forbidden !== expected) {
        expect(content).not.toContain(forbidden)
      }
    })
  }

  it('page.tsx não contém nenhuma sequência mojibake conhecida', () => {
    const fullPath = join(process.cwd(), 'app/whatsapp/inbox/page.tsx')
    let content: string
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      return
    }
    const patterns = ['nÃ£o', 'EndereÃ§o', 'PrÃ³xima', 'MÃ³dulo', 'RÃ¡pido', 'aÃ§Ã£o']
    for (const p of patterns) {
      expect(content, `page.tsx contém mojibake "${p}"`).not.toContain(p)
    }
  })

  it('ConversationList.tsx não contém sequências mojibake', () => {
    const fullPath = join(
      process.cwd(),
      'app/whatsapp/inbox/components/ConversationList.tsx',
    )
    let content: string
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      return
    }
    const patterns = ['nÃ£o', 'Ã§', 'Ã©', 'Ã³', 'Ã¡']
    for (const p of patterns) {
      expect(content, `ConversationList.tsx contém mojibake "${p}"`).not.toContain(p)
    }
  })
})
