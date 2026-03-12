// GET    /api/lead-pools/:id — fetch a lead pool including leads_json
// DELETE /api/lead-pools/:id — delete a lead pool

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findLeadPoolById, deleteLeadPool } from '@/lib/lead-pool-repo'
import { z } from 'zod'

const UUIDSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/lead-pools/:id', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = UUIDSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const poolId = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const leadPool = await findLeadPoolById(client, poolId, auth.workspace_id)

      if (!leadPool) return NextResponse.json({ error: 'Lead pool nao encontrado' }, { status: 404 })

      log.info({ poolId, lead_count: leadPool.lead_count }, 'Lead pool carregado')
      return NextResponse.json({ data: leadPool })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao carregar lead pool')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'DELETE /api/lead-pools/:id', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = UUIDSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const poolId = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const deleted = await deleteLeadPool(client, poolId, auth.workspace_id)

      if (!deleted) return NextResponse.json({ error: 'Lead pool nao encontrado' }, { status: 404 })

      log.info({ poolId }, 'Lead pool deletado')
      return NextResponse.json({ success: true })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao deletar lead pool')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
