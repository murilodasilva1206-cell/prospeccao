// POST /api/auth/login
// Validates email + password, creates a web session, and sets an HttpOnly cookie.
// Rate limited to 5 attempts / minute / IP to prevent brute-force attacks.

import { NextRequest, NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { loginLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { findUserByEmail, verifyPassword } from '@/lib/user-auth'
import { createWebSession } from '@/lib/web-session'
import { env } from '@/lib/env'

const SESSION_COOKIE = 'session'
const SESSION_EXP_COOKIE = 'session_exp' // non-HttpOnly companion: lets middleware check expiry without DB
const SESSION_MAX_AGE = 28800 // 8 hours in seconds

const LoginSchema = z.object({
  email: z.string().email('Email invalido'),
  password: z.string().min(1, 'Senha obrigatoria'),
})

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/auth/login', ip })

  // Rate limit: prevent brute force
  const rateLimit = await loginLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas tentativas de login. Aguarde um minuto.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
        },
      },
    )
  }

  let body: z.infer<typeof LoginSchema>
  try {
    const raw = await request.json()
    body = LoginSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    const user = await findUserByEmail(client, body.email)

    // Always run verifyPassword even on "not found" to prevent timing oracle
    const validPassword = user
      ? await verifyPassword(body.password, user.password_hash)
      : await verifyPassword(body.password, 'deadbeef:deadbeef') // dummy — always false

    if (!user || !validPassword) {
      log.warn({ email: body.email }, 'Tentativa de login com credenciais invalidas')
      return NextResponse.json({ error: 'Email ou senha incorretos' }, { status: 401 })
    }

    const rawToken = await createWebSession(client, {
      user_id: user.id,
      workspace_id: user.workspace_id,
    })

    log.info({ userId: user.id, workspace_id: user.workspace_id }, 'Login bem-sucedido')

    const response = NextResponse.json({
      workspace_id: user.workspace_id,
      email: user.email,
    })

    const isProduction = env.NODE_ENV === 'production'
    const expiryTimestamp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE

    response.cookies.set(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    })

    // Companion cookie (non-HttpOnly): middleware reads this to check expiry
    // without a DB round-trip. Not sensitive — actual auth is in the HttpOnly token.
    response.cookies.set(SESSION_EXP_COOKIE, String(expiryTimestamp), {
      httpOnly: false,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    })

    return response
  } finally {
    client.release()
  }
}
