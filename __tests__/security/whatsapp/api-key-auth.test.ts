import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Security tests for API key authentication middleware
// ---------------------------------------------------------------------------

function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (authHeader !== undefined) headers['Authorization'] = authHeader
  return new NextRequest('http://localhost/api/test', { headers })
}

function makeMockClient(validKey = false, workspaceId = 'ws-secure'): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({
      rows: validKey
        ? [{ id: 'key-id-1', workspace_id: workspaceId, label: 'Test Key' }]
        : [],
      rowCount: validKey ? 1 : 0,
    }),
  } as unknown as PoolClient
}

describe('Security: API key authentication', () => {
  it('throws AuthError when Authorization header is absent', async () => {
    const req = makeRequest(undefined)
    const client = makeMockClient(false)
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow(AuthError)
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow('Missing Authorization header')
  })

  it('throws AuthError for non-Bearer scheme', async () => {
    const req = makeRequest('Basic dXNlcjpwYXNz')
    const client = makeMockClient(false)
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow('Bearer scheme')
  })

  it('throws AuthError for key not starting with wk_', async () => {
    const req = makeRequest('Bearer sk_not_a_workspace_key_12345678901234567890123456789012345')
    const client = makeMockClient(false)
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow('Invalid API key format')
  })

  it('throws AuthError for unknown key (not in DB)', async () => {
    const req = makeRequest('Bearer wk_' + '0'.repeat(64))
    const client = makeMockClient(false)  // empty rows = unknown key
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow('Invalid or revoked API key')
  })

  it('returns workspace_id from DB, not from request body', async () => {
    const req = makeRequest('Bearer wk_' + 'a'.repeat(64))
    const client = makeMockClient(true, 'ws-from-db')
    const auth = await requireWorkspaceAuth(req, client)
    expect(auth.workspace_id).toBe('ws-from-db')
  })

  it('returns actor in format api_key:<label>', async () => {
    const req = makeRequest('Bearer wk_' + 'b'.repeat(64))
    const client = makeMockClient(true)
    const auth = await requireWorkspaceAuth(req, client)
    expect(auth.actor).toBe('api_key:Test Key')
  })

  it('does not expose key material in returned AuthContext', async () => {
    const rawKey = 'wk_' + 'c'.repeat(64)
    const req = makeRequest(`Bearer ${rawKey}`)
    const client = makeMockClient(true)
    const auth = await requireWorkspaceAuth(req, client)
    const authStr = JSON.stringify(auth)
    expect(authStr).not.toContain(rawKey)
    expect(authStr).not.toContain('wk_')
  })

  it('throws AuthError for malformed Bearer (no token)', async () => {
    const req = makeRequest('Bearer ')
    const client = makeMockClient(false)
    await expect(requireWorkspaceAuth(req, client)).rejects.toThrow(AuthError)
  })
})
