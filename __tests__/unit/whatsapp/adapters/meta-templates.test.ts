import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'

// ---------------------------------------------------------------------------
// Unit: MetaAdapter.syncTemplates() — mocked via MSW
// ---------------------------------------------------------------------------

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspace_id: 'ws-tpl-test',
    name: 'Meta Templates Channel',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    phone_number: '+5511900000000',
    external_instance_id: '109876543210',
    credentials_encrypted: 'fake-blob',
    webhook_secret: 'whsec_test',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

const creds: ChannelCredentials = {
  access_token: 'EAABtest123',
  phone_number_id: '109876543210',
  waba_id: 'WABA_001',
  app_secret: 'app_secret_value',
}

const adapter = new MetaAdapter()

const sampleTemplate = {
  id: 'tpl_001',
  name: 'boas_vindas',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' },
    { type: 'BODY', text: 'Prezado {{1}}, temos uma oferta para {{2}}.' },
    { type: 'FOOTER', text: 'Responda PARE para cancelar.' },
  ],
}

// ---------------------------------------------------------------------------
// syncTemplates — happy path
// ---------------------------------------------------------------------------

describe('MetaAdapter.syncTemplates — happy path', () => {
  it('returns all templates from a single page response', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({
          data: [sampleTemplate],
          paging: {},
        }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('boas_vindas')
    expect(results[0].language).toBe('pt_BR')
    expect(results[0].status).toBe('APPROVED')
    expect(results[0].category).toBe('MARKETING')
    expect(results[0].components).toHaveLength(3)
  })

  it('follows next cursor and aggregates all pages', async () => {
    const page1 = {
      data: [{ ...sampleTemplate, id: 'tpl_001', name: 'template_a' }],
      paging: { cursors: { after: 'cursor_abc' }, next: `${GRAPH_BASE}/${creds.waba_id}/message_templates?after=cursor_abc` },
    }
    const page2 = {
      data: [{ ...sampleTemplate, id: 'tpl_002', name: 'template_b' }],
      paging: {},
    }

    // First request (no cursor) → page1; second request (with after) → page2
    let callCount = 0
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, ({ request }) => {
        callCount++
        const url = new URL(request.url)
        return url.searchParams.get('after')
          ? HttpResponse.json(page2)
          : HttpResponse.json(page1)
      }),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.name)).toEqual(['template_a', 'template_b'])
    expect(callCount).toBe(2)
  })

  it('returns empty array when provider returns no templates', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ data: [], paging: {} }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// syncTemplates — error handling
// ---------------------------------------------------------------------------

describe('MetaAdapter.syncTemplates — error handling', () => {
  it('throws when waba_id is missing from credentials', async () => {
    const credsNoWaba = { ...creds, waba_id: undefined }
    await expect(
      adapter.syncTemplates(makeChannel(), credsNoWaba),
    ).rejects.toThrow(/waba_id/)
  })

  it('throws (non-retryable) on 401 Unauthorized', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ error: { message: 'Invalid OAuth token' } }, { status: 401 }),
      ),
    )

    await expect(adapter.syncTemplates(makeChannel(), creds)).rejects.toThrow('401')
  })

  it('throws (non-retryable) on 403 Forbidden', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ error: { message: 'Permission denied' } }, { status: 403 }),
      ),
    )

    await expect(adapter.syncTemplates(makeChannel(), creds)).rejects.toThrow('403')
  })

  it('throws RetryableError on 429', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ error: 'rate limit' }, { status: 429 }),
      ),
    )

    const { RetryableError } = await import('@/lib/whatsapp/errors')
    await expect(adapter.syncTemplates(makeChannel(), creds)).rejects.toBeInstanceOf(RetryableError)
  })

  it('throws RetryableError on 500', async () => {
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ error: 'internal' }, { status: 500 }),
      ),
    )

    const { RetryableError } = await import('@/lib/whatsapp/errors')
    await expect(adapter.syncTemplates(makeChannel(), creds)).rejects.toBeInstanceOf(RetryableError)
  })
})

// ---------------------------------------------------------------------------
// syncTemplates — component parsing
// ---------------------------------------------------------------------------

describe('MetaAdapter.syncTemplates — component parsing', () => {
  it('parses BODY component text with {{N}} placeholders', async () => {
    const tpl = {
      ...sampleTemplate,
      components: [
        { type: 'BODY', text: 'Olá {{1}}, empresa {{2}}, cidade {{3}}.' },
      ],
    }
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ data: [tpl], paging: {} }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    const body = results[0].components.find((c) => c.type === 'BODY')
    expect(body?.text).toBe('Olá {{1}}, empresa {{2}}, cidade {{3}}.')
  })

  it('parses HEADER with IMAGE format (no text)', async () => {
    const tpl = {
      ...sampleTemplate,
      name: 'com_imagem',
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Veja nossa oferta.' },
      ],
    }
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ data: [tpl], paging: {} }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    const header = results[0].components.find((c) => c.type === 'HEADER')
    expect(header?.format).toBe('IMAGE')
    expect(header?.text).toBeUndefined()
  })

  it('parses BUTTONS component', async () => {
    const tpl = {
      ...sampleTemplate,
      name: 'com_botoes',
      components: [
        { type: 'BODY', text: 'Clique para saber mais.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Saiba mais', url: 'https://exemplo.com' }] },
      ],
    }
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ data: [tpl], paging: {} }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    const buttons = results[0].components.find((c) => c.type === 'BUTTONS')
    expect(buttons?.buttons).toHaveLength(1)
    expect(buttons?.buttons?.[0]).toMatchObject({ type: 'URL', text: 'Saiba mais' })
  })

  it('handles multiple languages for same template name', async () => {
    const ptBR = { ...sampleTemplate, id: 'tpl_ptbr', language: 'pt_BR' }
    const enUS = { ...sampleTemplate, id: 'tpl_enus', language: 'en_US', name: 'boas_vindas' }
    server.use(
      http.get(`${GRAPH_BASE}/${creds.waba_id}/message_templates`, () =>
        HttpResponse.json({ data: [ptBR, enUS], paging: {} }),
      ),
    )

    const results = await adapter.syncTemplates(makeChannel(), creds)
    expect(results).toHaveLength(2)
    const langs = results.map((r) => r.language)
    expect(langs).toContain('pt_BR')
    expect(langs).toContain('en_US')
  })
})
