import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { buscaLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { BuscaQuerySchema } from '@/lib/schemas'
import { buildContactsQuery, buildCountQuery } from '@/lib/query-builder'
import { maskContact } from '@/lib/mask-output'
import { resolveNichoCnae } from '@/lib/nicho-cnae'

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

  // 3. Resolve nicho -> cnae_principal if cnae_principal not explicitly provided
  if (filters.nicho && !filters.cnae_principal) {
    const resolved = resolveNichoCnae(filters.nicho)
    if (resolved) {
      filters = { ...filters, cnae_principal: resolved }
      log.debug({ nicho: filters.nicho, cnae: resolved }, 'Nicho resolvido para CNAE')
    }
  }

  // 4. Execute parameterized queries
  try {
    const client = await pool.connect()
    try {
      const { text, values } = buildContactsQuery(filters)
      const { text: countText, values: countValues } = buildCountQuery(filters)

      log.debug({ filters }, 'Executando busca')

      const [rows, countResult] = await Promise.all([
        client.query(text, values),
        client.query(countText, countValues),
      ])

      const data = rows.rows.map(maskContact)
      const total = Number(countResult.rows[0]?.total ?? 0)

      log.info({ resultCount: data.length, total }, 'Busca concluida')

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
