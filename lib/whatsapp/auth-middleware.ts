// ---------------------------------------------------------------------------
// Workspace auth middleware
//
// Used by ALL protected API routes: /api/whatsapp/*, /api/campaigns/*,
// /api/agente, /api/busca, /api/export.
// The workspace_id returned is authoritative — never trust the request body.
//
// Auth priority:
//   1. Session cookie `session` (human operator — web UI login)
//   2. Bearer wk_... token (external integration / API)
//
// CSRF: session-cookie auth on mutating methods validates the Origin header.
// Bearer-token auth is inherently CSRF-safe and skips that check.
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import { validateApiKey } from './auth'
import { validateWebSession } from '@/lib/web-session'

const SESSION_COOKIE = 'session'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove implicit default ports from a host string so that
 * "example.com:443" and "example.com" compare as equal.
 * Browsers sometimes include the default port in the Origin header even when
 * the server's Host / x-forwarded-host header omits it.
 */
function stripDefaultPort(host: string): string {
  return host.replace(/:443$/, '').replace(/:80$/, '')
}

// ---------------------------------------------------------------------------
// Main middleware function
// ---------------------------------------------------------------------------

export interface AuthContext {
  workspace_id: string
  actor: string          // 'session:<user_id>' or 'api_key:<label>' — used in audit logs
  key_id: string         // session UUID or api_key UUID
  dedup_actor_id: string // stable per-user ID for lead deduplication:
                         //   session  → 'session:<user_id>'  (user UUID, stable across logins)
                         //   api_key  → 'api_key:<key_id>'   (key UUID, stable; label can change)
}

/**
 * Extracts and validates workspace identity from the request.
 * Tries session cookie first (web UI), then Bearer wk_... token (API integrations).
 * Throws AuthError (→ 401) if neither is valid.
 *
 * CSRF: When authenticating via session cookie, mutating methods (POST/PUT/PATCH/DELETE)
 * are checked for a matching Origin header as defense-in-depth against CSRF.
 * SameSite=Strict already prevents cookie inclusion on cross-site requests; Origin
 * validation adds a second layer for complex same-site subdomain scenarios.
 * Bearer-token auth is inherently CSRF-safe and skips the Origin check.
 *
 * Usage in API routes:
 *   const { workspace_id, actor } = await requireWorkspaceAuth(request, client)
 *
 * The workspace_id comes from the DB — never from the request body or query string.
 */
export async function requireWorkspaceAuth(
  request: NextRequest,
  client: PoolClient,
): Promise<AuthContext> {
  // ---------------------------------------------------------------------------
  // 1. Session cookie (human operator via web login)
  // ---------------------------------------------------------------------------
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value
  if (sessionToken) {
    const session = await validateWebSession(client, sessionToken)
    if (session) {
      // CSRF: validate Origin header for mutating requests authenticated via cookie.
      // GET/HEAD are safe methods and exempt. Bearer-token path below is also exempt.
      const method = request.method.toUpperCase()
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const origin = request.headers.get('origin')
        if (origin) {
          // Prefer x-forwarded-host (set by reverse proxies/CDNs like Vercel, nginx)
          // so that the comparison uses the public-facing hostname, not the internal one.
          // Normalize: take the first value (some proxies send comma-separated list),
          // trim whitespace, and lowercase for a case-insensitive comparison.
          const rawHost =
            request.headers.get('x-forwarded-host') ??
            request.headers.get('host') ??
            ''
          // Normalize: first comma-separated value, trimmed, lowercase, no default ports.
          // Browsers may include :443 or :80 in Origin even when the host header omits them.
          const host = stripDefaultPort(rawHost.split(',')[0].trim().toLowerCase())
          let originHost: string
          try {
            originHost = stripDefaultPort(new URL(origin).host.toLowerCase())
          } catch {
            throw new AuthError('Malformed Origin header')
          }
          if (originHost !== host) {
            throw new AuthError('Cross-origin request not allowed')
          }
        }
        // No Origin header → server-side call, CLI, or same-origin non-browser — allow.
      }

      return {
        workspace_id:   session.workspace_id,
        actor:          `session:${session.user_id}`,
        key_id:         session.session_id,
        dedup_actor_id: `session:${session.user_id}`,  // user_id is stable across sessions
      }
    }
    // Cookie present but invalid/expired. If no Bearer token is available either,
    // return a specific "session expired" error rather than the generic
    // "Missing Authorization header" — makes debugging far easier in the browser.
    if (!request.headers.get('Authorization')) {
      throw new AuthError('Session expired, please log in again')
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Bearer wk_... token (external integrations and API consumers)
  // ---------------------------------------------------------------------------
  const authHeader = request.headers.get('Authorization')

  if (!authHeader) {
    throw new AuthError('Missing Authorization header')
  }

  if (!authHeader.startsWith('Bearer ')) {
    throw new AuthError('Authorization header must use Bearer scheme')
  }

  const rawKey = authHeader.slice(7).trim()

  if (!rawKey.startsWith('wk_')) {
    throw new AuthError('Invalid API key format')
  }

  const validated = await validateApiKey(client, rawKey)

  if (!validated) {
    throw new AuthError('Invalid or revoked API key')
  }

  return {
    workspace_id:   validated.workspace_id,
    actor:          `api_key:${validated.label}`,
    key_id:         validated.key_id,
    dedup_actor_id: `api_key:${validated.key_id}`,  // key_id UUID is stable; label can be renamed
  }
}

/**
 * Converts an error to a 401 NextResponse if it is an AuthError; returns null otherwise.
 * Routes use this pattern:
 *
 *   } catch (err) {
 *     const res = authErrorResponse(err)
 *     if (res) return res
 *     // handle other errors...
 *   }
 */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: 401 })
  }
  return null
}
