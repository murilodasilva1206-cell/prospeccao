// GET /api/auth/me
// Returns current session info (workspace_id, email) from the session cookie.
// Returns 401 if no valid session.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { getSessionUser } from '@/lib/web-session'

const SESSION_COOKIE = 'session'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'GET /api/auth/me' })

  const rawToken = request.cookies.get(SESSION_COOKIE)?.value
  if (!rawToken) {
    return NextResponse.json({ error: 'Nao autenticado' }, { status: 401 })
  }

  const client = await pool.connect()
  try {
    const sessionUser = await getSessionUser(client, rawToken)
    if (!sessionUser) {
      return NextResponse.json({ error: 'Sessao invalida ou expirada' }, { status: 401 })
    }

    log.info({ user_id: sessionUser.user_id }, 'Sessao validada')
    return NextResponse.json({
      workspace_id: sessionUser.workspace_id,
      email: sessionUser.email,
    })
  } finally {
    client.release()
  }
}
