// GET  /api/campaigns — list campaigns for the authenticated workspace
// POST /api/campaigns — create a draft campaign from agent search results
//
// Auth: Bearer wk_... workspace API key required.

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { randomBytes } from 'crypto'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { CreateCampaignSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  createCampaign,
  insertCampaignRecipients,
  insertCampaignAudit,
  findCampaignsByWorkspace,
} from '@/lib/campaign-repo'

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/campaigns', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaigns = await findCampaignsByWorkspace(client, auth.workspace_id)
      log.info({ workspace_id: auth.workspace_id, count: campaigns.length }, 'Campanhas listadas')
      return NextResponse.json({ data: campaigns })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao listar campanhas')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  let body
  try {
    const raw = await request.json()
    body = CreateCampaignSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'JSON inválido no corpo da requisição' }, { status: 400 })
  }

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      // Generate confirmation token — caller must echo it back to confirm the campaign.
      // This prevents CSRF-style auto-confirmation via crafted requests.
      const confirmationToken = randomBytes(32).toString('hex')

      // All three inserts run inside a single transaction so a mid-flight failure
      // (e.g. recipients insert error) cannot leave an orphaned campaign row.
      await client.query('BEGIN')
      let campaign: Awaited<ReturnType<typeof createCampaign>>
      try {
        campaign = await createCampaign(client, {
          workspace_id: auth.workspace_id,
          name: body.name ?? `Campanha ${new Date().toLocaleDateString('pt-BR')}`,
          search_filters: body.search_filters ?? null,
          total_count: body.recipients.length,
          created_by: auth.key_id,
          confirmation_token: confirmationToken,
        })

        await insertCampaignRecipients(client, campaign.id, body.recipients)

        await insertCampaignAudit(client, campaign.id, 'created', auth.key_id, {
          total_recipients: body.recipients.length,
          name: campaign.name,
        })

        await client.query('COMMIT')
      } catch (txErr) {
        await client.query('ROLLBACK')
        throw txErr
      }

      log.info(
        { campaignId: campaign.id, total: body.recipients.length },
        'Campanha criada em status draft',
      )

      // Return confirmation_token once — caller must store it to confirm later.
      // IMPORTANT: token is stripped from subsequent GET responses.
      return NextResponse.json(
        {
          data: { ...campaign, confirmation_token: undefined },
          confirmation_token: confirmationToken,
          next_step: 'Confirme a campanha enviando POST /api/campaigns/:id/confirm com o confirmation_token',
        },
        { status: 201 },
      )
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao criar campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
