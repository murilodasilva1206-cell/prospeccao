// ---------------------------------------------------------------------------
// Security tests — CSRF Origin validation in requireWorkspaceAuth()
//
// When a request is authenticated via session cookie (web UI), mutating
// methods (POST/PUT/PATCH/DELETE) that include an Origin header must have
// an Origin matching the server's Host.  This provides defense-in-depth
// against CSRF on top of SameSite=Strict.
//
// Key scenarios:
//   - POST + session + same-origin Origin  → allowed
//   - POST + session + cross-origin Origin → AuthError (401)
//   - POST + session + no Origin           → allowed (API/CLI callers)
//   - GET  + session + cross-origin Origin → allowed (safe method)
//   - POST + Bearer  + cross-origin Origin → allowed (Bearer is CSRF-safe)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Mock session and API-key validation (called inside requireWorkspaceAuth)
// vi.hoisted() ensures variables are available inside vi.mock() factories,
// which are hoisted above top-level const declarations.
// ---------------------------------------------------------------------------

const { mockValidateWebSession, mockValidateApiKey } = vi.hoisted(() => ({
  mockValidateWebSession: vi.fn(),
  mockValidateApiKey: vi.fn(),
}))

vi.mock('@/lib/web-session', () => ({
  validateWebSession: mockValidateWebSession,
  createWebSession: vi.fn(),
  deleteWebSession: vi.fn(),
  getSessionUser: vi.fn(),
}))

vi.mock('@/lib/whatsapp/auth', () => ({
  validateApiKey: mockValidateApiKey,
}))

// ---------------------------------------------------------------------------
// Import the real (un-mocked) requireWorkspaceAuth
// ---------------------------------------------------------------------------

import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SESSION = {
  session_id: 'sess-uuid-1',
  user_id: 'user-uuid-1',
  workspace_id: 'ws-default',
}

/** Build a mock PoolClient (the function doesn't use query directly) */
function fakeClient(): PoolClient {
  return { query: vi.fn(), release: vi.fn() } as unknown as PoolClient
}

/**
 * Build a NextRequest with optional session cookie and optional Origin header.
 *
 * `origin` and `host` are injected via Object.defineProperty on `req.headers`
 * because happy-dom (the Vitest browser-like env) treats `Origin` as a
 * forbidden request header and silently drops it from the Headers constructor.
 * The production Next.js server has no such restriction — real browsers send
 * the Origin header on every cross-origin fetch.
 */
function makeRequest(
  method: string,
  opts: {
    sessionToken?: string
    origin?: string
    host?: string
    xForwardedHost?: string
    bearerToken?: string
  } = {},
): NextRequest {
  const reqHeaders: Record<string, string> = {}
  if (opts.bearerToken) reqHeaders['authorization'] = `Bearer ${opts.bearerToken}`

  const hostValue = opts.host ?? 'app.example.com'
  const req = new NextRequest(`http://${hostValue}/api/agente`, { method, headers: reqHeaders })

  // Patch cookies (same technique as auth-routes.test.ts)
  if (opts.sessionToken) {
    const token = opts.sessionToken
    Object.defineProperty(req, 'cookies', {
      configurable: true,
      get: () => ({
        get: (name: string) =>
          name === 'session' ? { name: 'session', value: token } : undefined,
        has: (name: string) => name === 'session',
      }),
    })
  }

  // Patch headers.get to inject origin, host, and x-forwarded-host
  // (forbidden or unreliable in happy-dom env)
  const originValue = opts.origin ?? null
  const xForwardedHostValue = opts.xForwardedHost ?? null
  const origHeadersGet = req.headers.get.bind(req.headers)
  Object.defineProperty(req, 'headers', {
    configurable: true,
    get: () => ({
      get: (name: string) => {
        const lower = name.toLowerCase()
        if (lower === 'origin') return originValue
        if (lower === 'host') return hostValue
        if (lower === 'x-forwarded-host') return xForwardedHostValue
        return origHeadersGet(name)
      },
    }),
  })

  return req
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // By default: valid session, no valid API key
  mockValidateWebSession.mockResolvedValue(FAKE_SESSION)
  mockValidateApiKey.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// Same-origin requests — must be allowed
// ---------------------------------------------------------------------------

describe('CSRF: same-origin POST with session cookie', () => {
  it('allows when Origin matches Host exactly', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://app.example.com',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })

  it('allows when Origin matches Host with port', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })
})

// ---------------------------------------------------------------------------
// Cross-origin POST with session cookie — must be rejected
// ---------------------------------------------------------------------------

describe('CSRF: cross-origin POST with session cookie', () => {
  it('rejects when Origin does not match Host', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.attacker.com',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(AuthError)
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow('Cross-origin request not allowed')
  })

  it('rejects malformed Origin header', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'not-a-url',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(AuthError)
  })

  it('rejected request is caught by authErrorResponse → 401 HTTP status', async () => {
    const { authErrorResponse } = await import('@/lib/whatsapp/auth-middleware')
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    let caught: unknown
    try {
      await requireWorkspaceAuth(req, fakeClient())
    } catch (err) {
      caught = err
    }
    const res = authErrorResponse(caught)
    expect(res?.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST with session cookie but no Origin — must be allowed
// (server-to-server calls, CLI tools, curl)
// ---------------------------------------------------------------------------

describe('CSRF: no Origin header with session cookie', () => {
  it('allows POST without Origin (non-browser callers)', async () => {
    const req = makeRequest('POST', { sessionToken: 'valid-token' })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })
})

// ---------------------------------------------------------------------------
// Safe HTTP methods (GET/HEAD) are exempt from Origin check
// ---------------------------------------------------------------------------

describe('CSRF: GET requests are not subject to Origin check', () => {
  it('allows GET with cross-origin Origin (safe method)', async () => {
    const req = makeRequest('GET', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })

  it('allows HEAD with cross-origin Origin (safe method)', async () => {
    const req = makeRequest('HEAD', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })
})

// ---------------------------------------------------------------------------
// Bearer token auth — CSRF check does not apply
// ---------------------------------------------------------------------------

describe('CSRF: Bearer token auth bypasses Origin check', () => {
  it('allows POST with cross-origin Origin when using Bearer token', async () => {
    const bearerToken = 'wk_' + 'b'.repeat(64)
    // No session cookie — falls through to Bearer path
    mockValidateApiKey.mockResolvedValue({
      workspace_id: 'ws-bearer',
      label: 'Integration',
      key_id: 'key-2',
    })
    const req = makeRequest('POST', {
      host: 'app.example.com',
      origin: 'https://evil.com', // cross-origin — irrelevant for Bearer auth
      bearerToken,
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-bearer')
    expect(ctx.actor).toBe('api_key:Integration')
  })
})

// ---------------------------------------------------------------------------
// All mutating methods are checked (not just POST)
// ---------------------------------------------------------------------------

describe('CSRF: PUT and DELETE are also checked', () => {
  it('rejects PUT with cross-origin Origin', async () => {
    const req = makeRequest('PUT', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(AuthError)
  })

  it('rejects DELETE with cross-origin Origin', async () => {
    const req = makeRequest('DELETE', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(AuthError)
  })

  it('rejects PATCH with cross-origin Origin', async () => {
    const req = makeRequest('PATCH', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'https://evil.com',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(AuthError)
  })
})

// ---------------------------------------------------------------------------
// x-forwarded-host: proxy/CDN scenarios
// ---------------------------------------------------------------------------

describe('CSRF: x-forwarded-host takes precedence over host', () => {
  it('allows when Origin matches x-forwarded-host (proxy rewrites internal host)', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'internal-lb.cluster.local', // internal hostname set by load balancer
      xForwardedHost: 'app.example.com', // public hostname from proxy
      origin: 'https://app.example.com',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })

  it('rejects when Origin does not match x-forwarded-host', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'internal-lb.cluster.local',
      xForwardedHost: 'app.example.com',
      origin: 'https://evil.com',
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow('Cross-origin request not allowed')
  })

  it('uses only the first value when x-forwarded-host is comma-separated', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'internal-lb.cluster.local',
      xForwardedHost: 'app.example.com, proxy.internal', // multi-hop proxy
      origin: 'https://app.example.com',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })
})

// ---------------------------------------------------------------------------
// Default port stripping: Origin with :443/:80 must match host without port
// ---------------------------------------------------------------------------

describe('CSRF: default ports stripped from Origin and host', () => {
  it('allows when Origin includes :443 but host omits it (standard HTTPS)', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',         // no port — normal for HTTPS host headers
      origin: 'https://app.example.com:443', // browser may include default port
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })

  it('allows when Origin includes :80 but host omits it (standard HTTP)', async () => {
    const req = makeRequest('POST', {
      sessionToken: 'valid-token',
      host: 'app.example.com',
      origin: 'http://app.example.com:80',
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-default')
  })
})

// ---------------------------------------------------------------------------
// Session expired / revoked: specific error message
// ---------------------------------------------------------------------------

describe('Auth: session cookie present but invalid or revoked', () => {
  it('throws "Session expired" when cookie token is invalid and no Bearer', async () => {
    mockValidateWebSession.mockResolvedValue(null) // session not found / expired in DB
    const req = makeRequest('POST', {
      sessionToken: 'stale-or-revoked-token',
      // No bearerToken — falls into the session-expired branch
    })
    await expect(requireWorkspaceAuth(req, fakeClient())).rejects.toThrow(
      'Session expired, please log in again',
    )
  })

  it('falls through to Bearer when cookie is invalid but Authorization header is present', async () => {
    mockValidateWebSession.mockResolvedValue(null) // cookie invalid
    const bearerToken = 'wk_' + 'c'.repeat(64)
    mockValidateApiKey.mockResolvedValue({
      workspace_id: 'ws-bearer',
      label: 'Integration',
      key_id: 'key-3',
    })
    const req = makeRequest('POST', {
      sessionToken: 'stale-token',
      bearerToken, // valid Bearer present — should succeed via that path
    })
    const ctx = await requireWorkspaceAuth(req, fakeClient())
    expect(ctx.workspace_id).toBe('ws-bearer')
  })
})
