// POST /api/auth/logout
// Deletes the current web session from DB and clears both session cookies.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { deleteWebSession } from '@/lib/web-session'
import { env } from '@/lib/env'

const SESSION_COOKIE = 'session'
const SESSION_EXP_COOKIE = 'session_exp'

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'POST /api/auth/logout' })

  const rawToken = request.cookies.get(SESSION_COOKIE)?.value

  if (rawToken) {
    const client = await pool.connect()
    try {
      await deleteWebSession(client, rawToken)
    } catch (err) {
      log.error({ err }, 'Erro ao deletar sessao no logout')
      // Still clear the cookie even if DB deletion fails
    } finally {
      client.release()
    }
  }

  log.info('Logout realizado')

  const isProduction = env.NODE_ENV === 'production'
  const response = NextResponse.json({ ok: true })
  // Clear both cookies by setting maxAge=0 (same flags as login for consistency)
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  })
  response.cookies.set(SESSION_EXP_COOKIE, '', {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  })

  return response
}
