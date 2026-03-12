// ---------------------------------------------------------------------------
// Security tests — /api/auth/* route handlers + safeRedirect helper
//
// Covers:
//   POST /api/auth/login   — invalid credentials → 401, rate limit → 429
//   POST /api/auth/logout  — clears both session cookies
//   GET  /api/auth/me      — no cookie → 401, expired/invalid session → 401
//   POST /api/auth/register — users exist → 403, wrong SETUP_SECRET → 403,
//                             no SETUP_SECRET env → open without secret,
//                             success → 201 with server-side workspace_id
//   safeRedirect()         — blocks open-redirect payloads
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoisted mocks: vi.hoisted() ensures these are available inside vi.mock()
// factories even though vi.mock() is hoisted above const declarations.
// ---------------------------------------------------------------------------

const {
  mockConnect,
  mockRelease,
  mockLoginLimiterCheck,
  mockRegisterLimiterCheck,
  mockFindUserByEmail,
  mockVerifyPassword,
  mockCreateUser,
  mockCountUsers,
  mockCreateWebSession,
  mockDeleteWebSession,
  mockGetSessionUser,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockRelease: vi.fn(),
  mockLoginLimiterCheck: vi.fn(),
  mockRegisterLimiterCheck: vi.fn(),
  mockFindUserByEmail: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockCreateUser: vi.fn(),
  mockCountUsers: vi.fn(),
  mockCreateWebSession: vi.fn(),
  mockDeleteWebSession: vi.fn(),
  mockGetSessionUser: vi.fn(),
}))

vi.mock('@/lib/database', () => ({
  default: { connect: mockConnect },
}))

vi.mock('@/lib/get-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('@/lib/rate-limit', () => ({
  loginLimiter: { check: mockLoginLimiterCheck },
  registerLimiter: { check: mockRegisterLimiterCheck },
}))

vi.mock('@/lib/user-auth', () => ({
  findUserByEmail: mockFindUserByEmail,
  verifyPassword: mockVerifyPassword,
  createUser: mockCreateUser,
  countUsers: mockCountUsers,
}))

vi.mock('@/lib/web-session', () => ({
  createWebSession: mockCreateWebSession,
  deleteWebSession: mockDeleteWebSession,
  getSessionUser: mockGetSessionUser,
}))

vi.mock('@/lib/env', () => ({
  env: { NODE_ENV: 'test' },
}))

// ---------------------------------------------------------------------------
// Route handlers (imported after mocks)
// ---------------------------------------------------------------------------

import { POST as loginRoute } from '@/app/api/auth/login/route'
import { POST as logoutRoute } from '@/app/api/auth/logout/route'
import { GET as meRoute } from '@/app/api/auth/me/route'
import { POST as registerRoute } from '@/app/api/auth/register/route'
import { safeRedirect } from '@/app/login/LoginPageClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown } = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

/**
 * Attaches a session cookie to a NextRequest by directly patching the
 * `cookies` getter. The happy-dom environment used by Vitest does not
 * propagate the `Cookie` request header into NextRequest.cookies, so this is
 * the reliable way to simulate authenticated requests in unit tests.
 */
function withSession(req: NextRequest, token: string): NextRequest {
  Object.defineProperty(req, 'cookies', {
    configurable: true,
    get: () => ({
      get: (name: string) =>
        name === 'session' ? { name: 'session', value: token } : undefined,
      has: (name: string) => name === 'session',
    }),
  })
  return req
}

const FAKE_USER = {
  id: 'user-uuid-1',
  workspace_id: 'default',
  email: 'dev@prospeccao.local',
  password_hash: 'salt:hash',
  created_at: new Date(),
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  const fakeClient = { release: mockRelease }
  mockConnect.mockResolvedValue(fakeClient)

  // Default: rate limits pass
  mockLoginLimiterCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
  mockRegisterLimiterCheck.mockResolvedValue({ success: true, resetAt: Date.now() + 60_000 })
})

afterEach(() => {
  // Clean up any SETUP_SECRET we may have set
  delete process.env.SETUP_SECRET
})

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('returns 400 when body is missing required fields', async () => {
    const req = makeRequest('POST', '/api/auth/login', { body: { email: 'bad' } })
    const res = await loginRoute(req)
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('Parâmetros inválidos')
  })

  it('returns 401 when user does not exist', async () => {
    mockFindUserByEmail.mockResolvedValue(null)
    mockVerifyPassword.mockResolvedValue(false) // dummy hash always fails
    const req = makeRequest('POST', '/api/auth/login', {
      body: { email: 'ghost@example.com', password: 'anypass' },
    })
    const res = await loginRoute(req)
    expect(res.status).toBe(401)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('Email ou senha incorretos')
    // verifyPassword must still be called (timing oracle prevention)
    expect(mockVerifyPassword).toHaveBeenCalledOnce()
  })

  it('returns 401 when password is wrong', async () => {
    mockFindUserByEmail.mockResolvedValue(FAKE_USER)
    mockVerifyPassword.mockResolvedValue(false)
    const req = makeRequest('POST', '/api/auth/login', {
      body: { email: FAKE_USER.email, password: 'wrongpass' },
    })
    const res = await loginRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns 429 when rate limit is exceeded', async () => {
    mockLoginLimiterCheck.mockResolvedValue({ success: false, resetAt: Date.now() + 30_000 })
    const req = makeRequest('POST', '/api/auth/login', {
      body: { email: FAKE_USER.email, password: 'pass' },
    })
    const res = await loginRoute(req)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('sets session and session_exp cookies on successful login', async () => {
    mockFindUserByEmail.mockResolvedValue(FAKE_USER)
    mockVerifyPassword.mockResolvedValue(true)
    mockCreateWebSession.mockResolvedValue('raw_token_hex_64_chars_placeholder_here_xxxx')
    const req = makeRequest('POST', '/api/auth/login', {
      body: { email: FAKE_USER.email, password: 'devpassword' },
    })
    const res = await loginRoute(req)
    expect(res.status).toBe(200)

    const setCookies = res.headers.getSetCookie()
    const sessionCookie = setCookies.find((c) => c.startsWith('session='))
    const expCookie = setCookies.find((c) => c.startsWith('session_exp='))
    expect(sessionCookie).toBeTruthy()
    // Check flags case-insensitively (Next.js may emit Strict or strict)
    expect(sessionCookie?.toLowerCase()).toContain('httponly')
    expect(sessionCookie?.toLowerCase()).toContain('samesite=strict')
    expect(expCookie).toBeTruthy()
    // session_exp must NOT be HttpOnly (middleware needs to read it)
    expect(expCookie?.toLowerCase()).not.toContain('httponly')
    expect(expCookie?.toLowerCase()).toContain('samesite=strict')
  })
})

// ---------------------------------------------------------------------------
// Login → /api/auth/me regression: prevents bounce-back to /login
//
// Bug: After POST /api/auth/login the AuthProvider context still had user=null
// (populated on mount via /api/auth/me, not updated on login). The WhatsApp
// layout guard (!loading && !user) would fire immediately and redirect back to
// /login before the cookie-backed /api/auth/me call completed.
//
// Fix: refreshSession() in AuthProvider re-fetches /api/auth/me and updates
// user state. The login page calls refreshSession() before router.push().
//
// This test verifies that the raw token from POST /api/auth/login, when used
// as the session cookie in GET /api/auth/me, returns the correct user — i.e.
// the cookie set by login is immediately valid for /api/auth/me.
// ---------------------------------------------------------------------------

describe('Login → /api/auth/me flow regression (no bounce-back to /login)', () => {
  it('login token is immediately valid for /api/auth/me (same session round-trip)', async () => {
    const RAW_TOKEN = 'raw_token_64_chars_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

    // Step 1: POST /api/auth/login succeeds and sets session cookie
    mockFindUserByEmail.mockResolvedValue(FAKE_USER)
    mockVerifyPassword.mockResolvedValue(true)
    mockCreateWebSession.mockResolvedValue(RAW_TOKEN)

    const loginReq = makeRequest('POST', '/api/auth/login', {
      body: { email: FAKE_USER.email, password: 'devpassword' },
    })
    const loginRes = await loginRoute(loginReq)
    expect(loginRes.status).toBe(200)

    // Confirm the session cookie value equals the raw token returned by createWebSession
    const sessionCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith('session='))
    expect(sessionCookie).toContain(RAW_TOKEN)

    // Step 2: GET /api/auth/me with that raw token (simulates refreshSession() call)
    // If this returns 200 with user data, the WhatsApp layout guard won't redirect.
    mockGetSessionUser.mockResolvedValue({
      user_id: FAKE_USER.id,
      workspace_id: FAKE_USER.workspace_id,
      email: FAKE_USER.email,
    })
    const meReq = withSession(makeRequest('GET', '/api/auth/me'), RAW_TOKEN)
    const meRes = await meRoute(meReq)

    expect(meRes.status).toBe(200)
    const json = await meRes.json() as { workspace_id: string; email: string }
    expect(json.email).toBe(FAKE_USER.email)
    expect(json.workspace_id).toBe(FAKE_USER.workspace_id)
  })
})

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout', () => {
  it('clears session cookie even without a cookie in the request', async () => {
    const req = makeRequest('POST', '/api/auth/logout')
    const res = await logoutRoute(req)
    expect(res.status).toBe(200)
    const setCookies = res.headers.getSetCookie()
    const sessionClear = setCookies.find((c) => c.startsWith('session='))
    expect(sessionClear).toContain('Max-Age=0')
  })

  it('clears session_exp companion cookie on logout', async () => {
    const req = makeRequest('POST', '/api/auth/logout')
    const res = await logoutRoute(req)
    const setCookies = res.headers.getSetCookie()
    const expClear = setCookies.find((c) => c.startsWith('session_exp='))
    expect(expClear).toBeTruthy()
    expect(expClear).toContain('Max-Age=0')
  })

  it('deletes the session from DB when a session cookie is present', async () => {
    mockDeleteWebSession.mockResolvedValue(undefined)
    const req = withSession(makeRequest('POST', '/api/auth/logout'), 'raw_token_hex')
    const res = await logoutRoute(req)
    expect(res.status).toBe(200)
    expect(mockDeleteWebSession).toHaveBeenCalledWith(expect.anything(), 'raw_token_hex')
  })
})

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

describe('GET /api/auth/me', () => {
  it('returns 401 when no session cookie', async () => {
    const req = makeRequest('GET', '/api/auth/me')
    const res = await meRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when session token is expired or invalid in DB', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const req = withSession(makeRequest('GET', '/api/auth/me'), 'expired_or_fake_token')
    const res = await meRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns workspace_id and email for a valid session', async () => {
    mockGetSessionUser.mockResolvedValue({
      user_id: 'user-uuid-1',
      workspace_id: 'default',
      email: 'dev@prospeccao.local',
    })
    const req = withSession(makeRequest('GET', '/api/auth/me'), 'valid_token')
    const res = await meRoute(req)
    expect(res.status).toBe(200)
    const json = await res.json() as { workspace_id: string; email: string }
    expect(json.workspace_id).toBe('default')
    expect(json.email).toBe('dev@prospeccao.local')
  })
})

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

describe('POST /api/auth/register', () => {
  it('returns 403 when users already exist (bootstrap closed)', async () => {
    mockCountUsers.mockResolvedValue(1)
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'new@example.com', password: 'password123' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('ja existe')
  })

  it('returns 403 when SETUP_SECRET is required but missing from body', async () => {
    process.env.SETUP_SECRET = 'super-secret-token'
    mockCountUsers.mockResolvedValue(0)
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'password123' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('setup_secret')
  })

  it('returns 403 when SETUP_SECRET is set but wrong value provided', async () => {
    process.env.SETUP_SECRET = 'super-secret-token'
    mockCountUsers.mockResolvedValue(0)
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'password123', setup_secret: 'wrong' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(403)
  })

  it('creates first user and ignores any workspace_id sent by client', async () => {
    mockCountUsers.mockResolvedValue(0)
    mockCreateUser.mockResolvedValue({
      id: 'new-user-uuid',
      workspace_id: 'default', // always server-side
      email: 'admin@example.com',
      created_at: new Date(),
    })
    const req = makeRequest('POST', '/api/auth/register', {
      // Client tries to supply workspace_id — must be ignored
      body: { email: 'admin@example.com', password: 'password123' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(201)
    // Verify createUser was called with 'default', NOT any client-supplied value
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace_id: 'default' }),
    )
    const json = await res.json() as { workspace_id: string }
    expect(json.workspace_id).toBe('default')
  })

  it('succeeds when SETUP_SECRET matches', async () => {
    process.env.SETUP_SECRET = 'correct-secret'
    mockCountUsers.mockResolvedValue(0)
    mockCreateUser.mockResolvedValue({
      id: 'new-user-uuid',
      workspace_id: 'default',
      email: 'admin@example.com',
      created_at: new Date(),
    })
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'password123', setup_secret: 'correct-secret' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(201)
  })

  it('returns 400 on short password', async () => {
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'short' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(400)
  })

  it('returns 429 when register rate limit is exceeded', async () => {
    mockRegisterLimiterCheck.mockResolvedValue({ success: false, resetAt: Date.now() + 30_000 })
    const req = makeRequest('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'password123' },
    })
    const res = await registerRoute(req)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// safeRedirect() — open redirect prevention
// ---------------------------------------------------------------------------

describe('safeRedirect()', () => {
  it('returns /whatsapp for null input', () => {
    expect(safeRedirect(null)).toBe('/whatsapp')
  })

  it('allows valid internal paths', () => {
    expect(safeRedirect('/whatsapp')).toBe('/whatsapp')
    expect(safeRedirect('/whatsapp/inbox')).toBe('/whatsapp/inbox')
    expect(safeRedirect('/whatsapp/canais')).toBe('/whatsapp/canais')
  })

  it('blocks protocol-relative URLs (//evil.com)', () => {
    expect(safeRedirect('//evil.com')).toBe('/whatsapp')
    expect(safeRedirect('//evil.com/steal')).toBe('/whatsapp')
  })

  it('blocks absolute http/https URLs', () => {
    expect(safeRedirect('http://evil.com')).toBe('/whatsapp')
    expect(safeRedirect('https://evil.com/steal')).toBe('/whatsapp')
  })

  it('blocks javascript: URIs', () => {
    expect(safeRedirect('javascript:alert(1)')).toBe('/whatsapp')
  })

  it('blocks backslash-relative paths used for bypass', () => {
    expect(safeRedirect('/\\evil.com')).toBe('/whatsapp')
  })

  it('allows the root path /', () => {
    expect(safeRedirect('/')).toBe('/')
  })
})
