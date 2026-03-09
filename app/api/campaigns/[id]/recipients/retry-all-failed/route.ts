// POST /api/campaigns/:id/recipients/retry-all-failed
//
// Resets ALL failed recipients in a campaign back to 'pending' in one atomic
// statement. Allowed when campaign is in: sending, paused, completed_with_errors.
//
// If the campaign was in completed_with_errors, it is reopened to sending so
// the cron immediately resumes processing. Everything runs inside an explicit
// transaction — the batch reset and the optional reopen are atomic.
//
// retry_count is intentionally NOT reset — each manual retry counts toward max_retries.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  findCampaignById,
  retryAllFailed,
  reopenCampaignToSending,
  insertCampaignAudit,
} from '@/lib/campaign-repo'
import { z } from 'zod'

const UUIDSchema = z.string().uuid()

type Params = { params: Promise<{ id: string }> }

const ALLOWED_STATUSES = ['sending', 'paused', 'completed_with_errors'] as const

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/recipients/retry-all-failed', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = UUIDSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
  const campaignId = idParsed.data

  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      }
      if (campaign.workspace_id !== auth.workspace_id) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (!(ALLOWED_STATUSES as readonly string[]).includes(campaign.status)) {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: `Retry em lote nao permitido (status da campanha: ${campaign.status})` },
          { status: 409 },
        )
      }

      const retried = await retryAllFailed(client, campaignId)
      if (retried === 0) {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: 'Nenhum destinatario com falha encontrado nesta campanha' },
          { status: 409 },
        )
      }

      // Reopen completed_with_errors campaigns so the cron picks up pending recipients
      let reopened = false
      if (campaign.status === 'completed_with_errors') {
        reopened = await reopenCampaignToSending(client, campaignId)
      }

      await insertCampaignAudit(client, campaignId, 'recipients_retry_all_failed', auth.key_id, {
        retried_count: retried,
        campaign_reopened: reopened,
      })

      await client.query('COMMIT')

      log.info({ campaignId, retried, reopened }, 'Retry em lote agendado')
      return NextResponse.json({ data: { retried_count: retried, campaign_reopened: reopened } })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao agendar retry em lote')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
