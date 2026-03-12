// GET /api/campaigns/:id/recipients — list recipients with pagination and status filter
//
// Auth: Bearer wk_... workspace API key required.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { RecipientPaginationSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, findRecipientsByCampaign, countRecipients } from '@/lib/campaign-repo'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/campaigns/:id/recipients', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = CampaignIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const campaignId = idParsed.data

  let query: z.infer<typeof RecipientPaginationSchema>
  try {
    query = RecipientPaginationSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    )
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const [recipients, total] = await Promise.all([
        findRecipientsByCampaign(client, campaignId, {
          limit: query.limit,
          offset: query.offset,
          status: query.status,
        }),
        countRecipients(client, campaignId, query.status),
      ])

      log.info({ campaignId, count: recipients.length }, 'Destinatarios listados')
      return NextResponse.json({
        data: recipients,
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
    log.error({ err }, 'Erro ao listar destinatarios')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
