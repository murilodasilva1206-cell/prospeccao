import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { buscaLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { BuscaQuerySchema } from '@/lib/schemas'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { maskContact } from '@/lib/mask-output'
import { getCnaeResolverService } from '@/lib/cnae-resolver-service'
import { requireWorkspaceAuth, authErrorResponse, type AuthContext } from '@/lib/whatsapp/auth-middleware'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: '/api/busca', ip })

  // 1. Rate limit — check before any DB work
  const rateLimit = await buscaLimiter.check(ip)
  if (!rateLimit.success) {
    log.warn('Limite de requisicoes excedido em /api/busca')
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
          ),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateLimit.resetAt),
        },
      },
    )
  }

  // 2. Parse and validate query parameters (Zod whitelist)
  let filters
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries())
    filters = BuscaQuerySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      log.info({ issues: err.issues }, 'Erro de validacao em /api/busca')
      return NextResponse.json(
        { error: 'Parametros invalidos', details: err.issues },
        { status: 400 },
      )
    }
    throw err
  }

  // 3. Auth — must precede CNAE resolution (which may call the IBGE API or DB).
  //    workspace_id is used for audit logging only; estabelecimentos is a public
  //    CNPJ registry shared across all workspaces — filtering by it would be wrong.
  let auth: AuthContext
  {
    const authClient = await pool.connect()
    try {
      auth = await requireWorkspaceAuth(request, authClient)
    } catch (err) {
      const res = authErrorResponse(err)
      if (res) return res
      log.error({ err }, 'Erro inesperado durante autenticacao em /api/busca')
      return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
    } finally {
      authClient.release()
    }
  }

  // 4. Resolve nicho → cnae_principal via the 4-layer cascade
  //    (LRU cache → cnae_dictionary → static map → IBGE API)
  //    Safe: only runs after a valid authenticated request.
  if (filters.nicho && !filters.cnae_principal) {
    const resolved = await getCnaeResolverService().resolve(filters.nicho)
    if (resolved) {
      filters = { ...filters, cnae_principal: resolved }
      log.debug({ nicho: filters.nicho, cnae: resolved }, 'Nicho resolvido para CNAE')
    }
  }

  // Guard: nicho was given but couldn't be mapped — reject rather than scanning
  // the whole table with no sector filter, which returns meaningless results.
  if (filters.nicho && !filters.cnae_principal) {
    return NextResponse.json(
      { error: 'Nicho não reconhecido. Tente um segmento mais específico, como "dentistas" ou "restaurantes".' },
      { status: 400 },
    )
  }

  // 5. Execute parameterized queries (single DB connection)
  try {
    const client = await pool.connect()
    try {
      const { text, values } = buildContactsQuery(filters)
      const { text: countText, values: countValues } = buildCountQuery(filters)

      log.debug({ filters, workspace_id: auth.workspace_id, actor: auth.actor }, 'Executando busca')

      const [rows, countResult] = await Promise.all([
        client.query(text, values),
        client.query(countText, countValues),
      ])

      const data = rows.rows.map(maskContact)
      const total = Number(countResult.rows[0]?.total ?? 0)

      log.info({ resultCount: data.length, total, workspace_id: auth.workspace_id, actor: auth.actor }, 'Busca concluida')

      return NextResponse.json({
        data,
        meta: {
          total,
          page: filters.page,
          limit: filters.limit,
          pages: Math.ceil(total / filters.limit),
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    // Log full error server-side; return generic message to client (no stack/SQL leak)
    log.error({ err }, 'Erro de banco de dados em /api/busca')
    return NextResponse.json(
      { error: 'Erro interno do servidor' },
      { status: 500 },
    )
  }
}
