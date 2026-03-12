// POST /api/auth/register
// Bootstrap endpoint: creates the first user account.
// Only works when the users table is empty — subsequent calls return 403.
//
// Security:
//   - workspace_id is NEVER accepted from the client; always set to 'default' on the server.
//   - If the SETUP_SECRET env var is set, the caller must provide it in the request body.
//     This prevents unauthorized takeover on fresh deployments that are publicly reachable.
//   - If SETUP_SECRET is not set, the endpoint works without a secret (simple/dev deployments).

import { NextRequest, NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { registerLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { createUser, countUsers } from '@/lib/user-auth'

const RegisterSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'Senha deve ter pelo menos 8 caracteres'),
  setup_secret: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/auth/register', ip })

  // Rate limit: prevent automated abuse on fresh deployments
  const rateLimit = await registerLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas tentativas. Aguarde um minuto.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
        },
      },
    )
  }

  let body: z.infer<typeof RegisterSchema>
  try {
    const raw = await request.json()
    body = RegisterSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON inválido no corpo da requisição' }, { status: 400 })
  }

  // If SETUP_SECRET is configured, the caller must supply it to prevent
  // unauthorized first-user creation on publicly reachable fresh deployments.
  const expectedSecret = process.env.SETUP_SECRET
  if (expectedSecret) {
    if (!body.setup_secret || body.setup_secret !== expectedSecret) {
      log.warn({ ip }, 'Tentativa de registro com setup_secret inválido')
      return NextResponse.json(
        { error: 'setup_secret incorreto ou ausente' },
        { status: 403 },
      )
    }
  }

  let client
  try {
    client = await pool.connect()
  } catch (err) {
    log.error({ err }, 'Falha ao conectar ao banco de dados no registro')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }

  try {
    const existingCount = await countUsers(client)
    if (existingCount > 0) {
      log.warn({ ip }, 'Tentativa de registro quando ja existem usuarios')
      return NextResponse.json(
        { error: 'Registro desabilitado: ja existe pelo menos um usuario cadastrado.' },
        { status: 403 },
      )
    }

    // workspace_id is always set server-side — never trusted from the client.
    const user = await createUser(client, {
      workspace_id: 'default',
      email: body.email,
      password: body.password,
    })

    log.info({ userId: user.id, email: user.email, workspace_id: user.workspace_id }, 'Primeiro usuario criado')

    return NextResponse.json(
      { id: user.id, email: user.email, workspace_id: user.workspace_id },
      { status: 201 },
    )
  } catch (err) {
    log.error({ err }, 'Erro de banco de dados no registro')
    // Surface actionable messages for common PG errors during first-deploy bootstrap
    const pgCode = (err as { code?: string }).code
    if (pgCode === '42P01') {
      // undefined_table: migration has not been applied yet
      return NextResponse.json(
        { error: 'Tabela de usuarios nao encontrada. Execute as migrations antes de registrar.' },
        { status: 500 },
      )
    }
    if (pgCode === '23505') {
      // unique_violation: email already exists (race condition on the bootstrap check)
      return NextResponse.json({ error: 'Email ja cadastrado' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  } finally {
    client.release()
  }
}
