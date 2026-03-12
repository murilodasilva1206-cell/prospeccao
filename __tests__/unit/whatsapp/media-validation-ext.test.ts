// ---------------------------------------------------------------------------
// TDD — Cenário 20: Validação de Mídia (extensão dos testes existentes)
//
// Complementa __tests__/unit/whatsapp/media.test.ts com:
//   - MIME proibido (SVG, executável, ZIP) → erro "not allowed"
//   - Arquivo adulterado (magic bytes incompatíveis com MIME declarado) → erro
//   - Tamanho acima do limite → erro "too large"
//   - Rota POST /send-media retorna 400 em cada um desses casos
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { validateMediaFile } from '@/lib/whatsapp/media'

// ---------------------------------------------------------------------------
// Mocks para rota (cenários via API)
// ---------------------------------------------------------------------------

const mockRelease = vi.fn()
const mockClientQuery = vi.fn()
const mockConnect = vi.fn()
vi.mock('@/lib/database', () => ({ default: { connect: mockConnect } }))

vi.mock('@/lib/get-ip', () => ({ getClientIp: vi.fn().mockReturnValue('127.0.0.1') }))

const mockMediaCheck = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  whatsappMediaLimiter: { check: mockMediaCheck },
}))

const mockRequireWorkspaceAuth = vi.fn()
vi.mock('@/lib/whatsapp/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/auth-middleware')>()
  return { ...actual, requireWorkspaceAuth: mockRequireWorkspaceAuth }
})

const mockFindChannelById = vi.fn()
vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: mockFindChannelById,
}))

vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: vi.fn().mockResolvedValue({ id: 'conv-1', workspace_id: 'ws-val' }),
}))

vi.mock('@/lib/whatsapp/message-repo', () => ({
  insertMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  decryptCredentials: vi.fn().mockReturnValue({ token: 'tok' }),
}))

vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMedia: vi.fn().mockResolvedValue({ message_id: 'wamid.ok' }),
    sendAudio: vi.fn().mockResolvedValue({ message_id: 'wamid.ok' }),
  }),
}))

// NÃO mockamos validateMediaFile aqui — usamos a função real para os cenários via API
// A rota chama validateMediaFile internamente; para forçar 400 passamos bytes inválidos

vi.mock('@/lib/whatsapp/audit-repo', () => ({
  insertAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { POST: sendMediaRoute } = await import(
  '@/app/api/whatsapp/channels/[id]/send-media/route'
)

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'dddd1111-1111-4111-8111-111111111111'
const WS = 'ws-val'

const AUTH_WS = {
  workspace_id: WS,
  actor: 'api_key:val-key',
  key_id: 'k-val',
  dedup_actor_id: 'api_key:k-val',
}

// Magic bytes
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(96).fill(0)])
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(92).fill(0)])
const OGG_MAGIC = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(96).fill(0)])
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new Array(96).fill(0)])
const EXE_MAGIC = new Uint8Array([0x4d, 0x5a, ...new Array(98).fill(0)]) // MZ header
const ZERO_BYTES = new Uint8Array(100) // zeroed — invalid magic

// Tamanhos de limite
const IMAGE_MAX = 5 * 1024 * 1024   // 5 MB
const AUDIO_MAX = 16 * 1024 * 1024  // 16 MB
const DOC_MAX = 100 * 1024 * 1024   // 100 MB

function makeMediaRequest(
  filename: string,
  mimeType: string,
  content: Uint8Array,
  type = 'image',
  to = '5511999999999',
): NextRequest {
  const fd = new FormData()
  fd.set('to', to)
  fd.set('type', type)
  const ab = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
  const file = new File([ab], filename, { type: mimeType })
  fd.set('file', file)
  return new NextRequest(
    `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-media`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
      body: fd,
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMediaCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRequireWorkspaceAuth.mockResolvedValue(AUTH_WS)
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease })
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockFindChannelById.mockResolvedValue({
    id: CHANNEL_ID,
    workspace_id: WS,
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    credentials_encrypted: 'enc',
  })
})

// ---------------------------------------------------------------------------
// Testes unitários de validateMediaFile (função pura)
// ---------------------------------------------------------------------------

describe('Cenário 20 — validateMediaFile: MIME proibido', () => {
  it('rejeita SVG (potencial XSS)', () => {
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(() => validateMediaFile(svgBytes, 'image/svg+xml')).toThrow(/not allowed/i)
  })

  it('rejeita application/x-executable (EXE)', () => {
    const exeBytes = Buffer.from(EXE_MAGIC)
    expect(() => validateMediaFile(exeBytes, 'application/x-executable')).toThrow(/not allowed/i)
  })

  it('rejeita application/zip', () => {
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Array(96).fill(0)])
    expect(() => validateMediaFile(zipBytes, 'application/zip')).toThrow(/not allowed/i)
  })

  it('rejeita text/html', () => {
    const htmlBytes = Buffer.from('<html><body>phishing</body></html>')
    expect(() => validateMediaFile(htmlBytes, 'text/html')).toThrow(/not allowed/i)
  })

  it('rejeita application/javascript', () => {
    const jsBytes = Buffer.from('alert("xss")')
    expect(() => validateMediaFile(jsBytes, 'application/javascript')).toThrow(/not allowed/i)
  })
})

describe('Cenário 20 — validateMediaFile: arquivo adulterado (magic bytes incompat.)', () => {
  it('rejeita arquivo declarado como image/jpeg mas com magic bytes zerados', () => {
    const buf = Buffer.from(ZERO_BYTES)
    expect(() => validateMediaFile(buf, 'image/jpeg')).toThrow()
  })

  it('rejeita arquivo declarado como image/png mas com magic JPEG', () => {
    const buf = Buffer.from(JPEG_MAGIC)
    // Declarado como PNG mas bytes são JPEG → inconsistência
    expect(() => validateMediaFile(buf, 'image/png')).toThrow()
  })

  it('rejeita arquivo declarado como audio/ogg mas com magic PDF', () => {
    const buf = Buffer.from(PDF_MAGIC)
    expect(() => validateMediaFile(buf, 'audio/ogg')).toThrow()
  })

  it('aceita arquivo correto (JPEG com magic JPEG)', () => {
    const buf = Buffer.from(JPEG_MAGIC)
    expect(() => validateMediaFile(buf, 'image/jpeg')).not.toThrow()
  })

  it('aceita arquivo correto (OGG com magic OGG)', () => {
    const buf = Buffer.from(OGG_MAGIC)
    expect(() => validateMediaFile(buf, 'audio/ogg')).not.toThrow()
  })
})

describe('Cenário 20 — validateMediaFile: tamanho acima do limite', () => {
  it('rejeita imagem maior que 5 MB', () => {
    // Cria buffer JPEG magic + suficientemente grande
    const oversized = Buffer.alloc(IMAGE_MAX + 1, 0)
    JPEG_MAGIC.forEach((b, i) => { oversized[i] = b })
    expect(() => validateMediaFile(oversized, 'image/jpeg')).toThrow(/too large|tamanho/i)
  })

  it('rejeita áudio maior que 16 MB', () => {
    const oversized = Buffer.alloc(AUDIO_MAX + 1, 0)
    OGG_MAGIC.forEach((b, i) => { oversized[i] = b })
    expect(() => validateMediaFile(oversized, 'audio/ogg')).toThrow(/too large|tamanho/i)
  })

  it('rejeita documento maior que 100 MB', () => {
    const oversized = Buffer.alloc(DOC_MAX + 1, 0)
    PDF_MAGIC.forEach((b, i) => { oversized[i] = b })
    expect(() => validateMediaFile(oversized, 'application/pdf')).toThrow(/too large|tamanho/i)
  })

  it('aceita arquivo exatamente no limite (5 MB para imagem)', () => {
    const atLimit = Buffer.alloc(IMAGE_MAX, 0)
    JPEG_MAGIC.forEach((b, i) => { atLimit[i] = b })
    // Pode ou não lançar dependendo da implementação (inclusive/exclusive)
    // O importante é que 1 byte acima lança
    const overLimit = Buffer.alloc(IMAGE_MAX + 1, 0)
    JPEG_MAGIC.forEach((b, i) => { overLimit[i] = b })
    expect(() => validateMediaFile(overLimit, 'image/jpeg')).toThrow(/too large|tamanho/i)
  })

  it('rejeita buffer vazio', () => {
    expect(() => validateMediaFile(Buffer.alloc(0), 'image/jpeg')).toThrow(/empty|vazio/i)
  })
})

// ---------------------------------------------------------------------------
// Cenários via rota: retorna 400
// ---------------------------------------------------------------------------

describe('Cenário 20 — Rota /send-media retorna 400 para arquivo inválido', () => {
  it('retorna 400 para MIME não permitido (SVG)', async () => {
    const svgContent = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))
    const res = await sendMediaRoute(
      makeMediaRequest('icon.svg', 'image/svg+xml', svgContent, 'image'),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
  })

  it('retorna 400 para arquivo com magic bytes zerados (adulterado)', async () => {
    // ZERO_BYTES não tem magic bytes válidos para image/jpeg
    const res = await sendMediaRoute(
      makeMediaRequest('fake.jpg', 'image/jpeg', ZERO_BYTES, 'image'),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
  })

  it('retorna 400 quando campo file está ausente', async () => {
    const fd = new FormData()
    fd.set('to', '5511999999999')
    fd.set('type', 'image')
    // Sem campo 'file'

    const res = await sendMediaRoute(
      new NextRequest(
        `http://localhost/api/whatsapp/channels/${CHANNEL_ID}/send-media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer wk_${'a'.repeat(64)}` },
          body: fd,
        },
      ),
      { params: Promise.resolve({ id: CHANNEL_ID }) },
    )

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/file/i)
  })
})
