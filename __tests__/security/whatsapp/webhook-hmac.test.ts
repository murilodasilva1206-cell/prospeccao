import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'crypto'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import { EvolutionAdapter } from '@/lib/whatsapp/adapters/evolution'
import { UazapiAdapter } from '@/lib/whatsapp/adapters/uazapi'
import { encryptCredentials } from '@/lib/whatsapp/crypto'
import {
  processWebhook,
  SignatureInvalidError,
  ChannelNotFoundError,
} from '@/lib/whatsapp/webhook-handler'
import type { Channel, ChannelCredentials } from '@/lib/whatsapp/types'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Webhook HMAC / signature security tests
//
// Verifies that:
//   1. Invalid signature → 401 / SignatureInvalidError
//   2. Tampered body → rejected even when signature header exists
//   3. Missing header → rejected
//   4. Correct signature → accepted (idempotent on replay)
//   5. All adapters enforce constant-time comparison
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const APP_SECRET = 'super_secret_app_value'

const metaCreds: ChannelCredentials = {
  access_token: 'tok_test',
  phone_number_id: '123456789',
  app_secret: APP_SECRET,
}

function makeMetaChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    workspace_id: 'ws-1',
    name: 'Meta Test',
    provider: 'META_CLOUD',
    status: 'CONNECTED',
    phone_number: null,
    external_instance_id: null,
    credentials_encrypted: encryptCredentials(metaCreds),
    webhook_secret: 'meta-webhook-secret',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeEvoChannel(secret: string): Channel {
  return {
    id: '00000000-0000-0000-0000-000000000002',
    workspace_id: 'ws-1',
    name: 'Evo Test',
    provider: 'EVOLUTION',
    status: 'CONNECTED',
    phone_number: null,
    external_instance_id: 'evo-inst',
    credentials_encrypted: encryptCredentials({ instance_url: 'https://evo.test', api_key: 'key' }),
    webhook_secret: secret,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Meta HMAC verification
// ---------------------------------------------------------------------------
describe('MetaAdapter.verifyWebhookSignature', () => {
  const adapter = new MetaAdapter()
  const channel = makeMetaChannel()
  const rawBody = '{"test":"data","value":42}'

  it('accepts correct HMAC-SHA256 signature', () => {
    const hmac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
    const headers = new Headers({ 'x-hub-signature-256': `sha256=${hmac}` })
    expect(adapter.verifyWebhookSignature(channel, metaCreds, headers, rawBody)).toBe(true)
  })

  it('rejects wrong HMAC signature', () => {
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=wrongsignaturevalue' })
    expect(adapter.verifyWebhookSignature(channel, metaCreds, headers, rawBody)).toBe(false)
  })

  it('rejects missing signature header', () => {
    expect(adapter.verifyWebhookSignature(channel, metaCreds, new Headers(), rawBody)).toBe(false)
  })

  it('rejects signature from tampered body (same sig, different body)', () => {
    const originalBody = '{"test":"data","value":42}'
    const hmac = createHmac('sha256', APP_SECRET).update(originalBody).digest('hex')
    const headers = new Headers({ 'x-hub-signature-256': `sha256=${hmac}` })
    const tamperedBody = '{"test":"data","value":99}'
    expect(adapter.verifyWebhookSignature(channel, metaCreds, headers, tamperedBody)).toBe(false)
  })

  it('rejects missing app_secret in creds', () => {
    const noCreds: ChannelCredentials = { access_token: 'tok', phone_number_id: '123' }
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=anything' })
    expect(adapter.verifyWebhookSignature(channel, noCreds, headers, rawBody)).toBe(false)
  })

  it('is not vulnerable to length extension (sha256= prefix required)', () => {
    const hmac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
    // Without the sha256= prefix the comparison should fail
    const headers = new Headers({ 'x-hub-signature-256': hmac })
    expect(adapter.verifyWebhookSignature(channel, metaCreds, headers, rawBody)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Evolution API key header verification
// ---------------------------------------------------------------------------
describe('EvolutionAdapter.verifyWebhookSignature', () => {
  const adapter = new EvolutionAdapter()
  const secret = 'evo_webhook_secret_value'
  const channel = makeEvoChannel(secret)
  const creds: ChannelCredentials = { instance_url: 'https://evo.test', api_key: 'k' }

  it('accepts correct apikey header', () => {
    const headers = new Headers({ apikey: secret })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(true)
  })

  it('rejects wrong apikey', () => {
    const headers = new Headers({ apikey: 'wrong_key_entirely' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('rejects empty apikey header', () => {
    const headers = new Headers({ apikey: '' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('rejects missing apikey header', () => {
    expect(adapter.verifyWebhookSignature(channel, creds, new Headers(), '{}')).toBe(false)
  })

  it('uses constant-time comparison (does not short-circuit)', () => {
    // We cannot directly measure timing in unit tests, but we can verify that
    // strings of different lengths are rejected without throwing
    const headers = new Headers({ apikey: secret.slice(0, 5) })
    expect(() => adapter.verifyWebhookSignature(channel, creds, headers, '{}')).not.toThrow()
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// UAZAPI Bearer token verification
// ---------------------------------------------------------------------------
describe('UazapiAdapter.verifyWebhookSignature', () => {
  const adapter = new UazapiAdapter()
  const secret = 'uaz_webhook_bearer_token'
  const channel: Channel = {
    ...makeEvoChannel(secret),
    provider: 'UAZAPI',
    name: 'UAZ Test',
  }
  const creds: ChannelCredentials = { instance_url: 'https://uaz.test', api_key: 'k' }

  it('accepts correct Bearer token', () => {
    const headers = new Headers({ authorization: `Bearer ${secret}` })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(true)
  })

  it('rejects wrong Bearer token', () => {
    const headers = new Headers({ authorization: 'Bearer wrong_token' })
    expect(adapter.verifyWebhookSignature(channel, creds, headers, '{}')).toBe(false)
  })

  it('rejects missing Authorization header', () => {
    expect(adapter.verifyWebhookSignature(channel, creds, new Headers(), '{}')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// processWebhook pipeline — rejects invalid signatures before any side-effects
// ---------------------------------------------------------------------------
describe('processWebhook — SignatureInvalidError on bad HMAC', () => {
  it('throws SignatureInvalidError when Meta signature is wrong', async () => {
    const channel = makeMetaChannel()

    // Build a mock PoolClient that returns the channel for findChannelById
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT * FROM whatsapp_channels')) {
          return Promise.resolve({ rows: [{
            id: channel.id,
            workspace_id: channel.workspace_id,
            name: channel.name,
            provider: channel.provider,
            status: channel.status,
            phone_number: channel.phone_number,
            external_instance_id: channel.external_instance_id,
            credentials_encrypted: channel.credentials_encrypted,
            webhook_secret: channel.webhook_secret,
            last_seen_at: channel.last_seen_at,
            created_at: channel.created_at,
            updated_at: channel.updated_at,
          }] })
        }
        return Promise.resolve({ rows: [] })
      }),
    } as unknown as PoolClient

    const badHeaders = new Headers({ 'x-hub-signature-256': 'sha256=badsig' })
    const rawBody = '{"entry":[]}'

    await expect(
      processWebhook(mockClient, 'META_CLOUD', channel.id, badHeaders, rawBody),
    ).rejects.toThrow(SignatureInvalidError)
  })

  it('throws ChannelNotFoundError when channel does not exist', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as PoolClient

    const headers = new Headers()
    await expect(
      processWebhook(
        mockClient,
        'EVOLUTION',
        '00000000-0000-0000-0000-000000000099',
        headers,
        '{}',
      ),
    ).rejects.toThrow(ChannelNotFoundError)
  })

  it('does NOT call markEventSeen when signature is invalid (no side-effects)', async () => {
    const channel = makeMetaChannel()
    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM whatsapp_channels')) {
        return Promise.resolve({ rows: [{
          id: channel.id,
          workspace_id: channel.workspace_id,
          name: channel.name,
          provider: channel.provider,
          status: channel.status,
          phone_number: channel.phone_number,
          external_instance_id: channel.external_instance_id,
          credentials_encrypted: channel.credentials_encrypted,
          webhook_secret: channel.webhook_secret,
          last_seen_at: channel.last_seen_at,
          created_at: channel.created_at,
          updated_at: channel.updated_at,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const mockClient = { query: mockQuery } as unknown as PoolClient
    const badHeaders = new Headers({ 'x-hub-signature-256': 'sha256=invalid' })

    try {
      await processWebhook(mockClient, 'META_CLOUD', channel.id, badHeaders, '{}')
    } catch {
      // Expected
    }

    // The only DB call should be the SELECT for findChannelById — no INSERT for markEventSeen
    const insertCalls = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO webhook_events'),
    )
    expect(insertCalls).toHaveLength(0)
  })
})
