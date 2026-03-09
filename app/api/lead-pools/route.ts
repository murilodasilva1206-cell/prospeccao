// GET  /api/lead-pools — list saved lead pools for the authenticated workspace
// POST /api/lead-pools — create a new lead pool from agent search results

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { CreateLeadPoolSchema, LeadPoolPaginationSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  createLeadPool,
  findLeadPoolsByWorkspace,
  countLeadPools,
} from '@/lib/lead-pool-repo'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/lead-pools', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  let query: { limit: number; offset: number }
  try {
    query = LeadPoolPaginationSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    )
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Parametros invalidos' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const [pools, total] = await Promise.all([
        findLeadPoolsByWorkspace(client, auth.workspace_id, query.limit, query.offset),
        countLeadPools(client, auth.workspace_id),
      ])

      log.info({ count: pools.length, workspace_id: auth.workspace_id }, 'Lead pools listados')
      return NextResponse.json({
        data: pools,
        meta: {
          total,
          limit: query.limit,
          offset: query.offset,
          pages: Math.ceil(total / query.limit),
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar lead pools')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/lead-pools', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  let body: { name: string; query_fingerprint?: string; filters_json?: Record<string, unknown>; leads: unknown[] }
  try {
    body = CreateLeadPoolSchema.parse(await request.json())
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parametros invalidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON invalido no corpo da requisicao' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const pool_ = await createLeadPool(client, {
        workspace_id:    auth.workspace_id,
        name:            body.name,
        query_fingerprint: body.query_fingerprint ?? null,
        filters_json:    body.filters_json ?? null,
        leads:           body.leads as never,
      })

      log.info({ id: pool_.id, lead_count: pool_.lead_count, workspace_id: auth.workspace_id }, 'Lead pool criado')
      return NextResponse.json({ data: pool_ }, { status: 201 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao criar lead pool')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
