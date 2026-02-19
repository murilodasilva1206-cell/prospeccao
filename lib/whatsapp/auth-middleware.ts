// ---------------------------------------------------------------------------
// Workspace auth middleware
//
// All protected WhatsApp API routes call requireWorkspaceAuth() first.
// The workspace_id returned is authoritative — never trust the request body.
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { PoolClient } from 'pg'
import { validateApiKey } from './auth'

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
// Main middleware function
// ---------------------------------------------------------------------------

export interface AuthContext {
  workspace_id: string
  actor: string   // 'api_key:<label>' — used in audit logs
  key_id: string
}

/**
 * Extracts and validates the workspace API key from the Authorization header.
 * Throws AuthError (→ 401) if the header is missing, malformed, or invalid.
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
    workspace_id: validated.workspace_id,
    actor: `api_key:${validated.label}`,
    key_id: validated.key_id,
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
