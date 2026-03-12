// POST /api/campaigns/:id/recipients/:rid/retry
//
// Manually resets a failed recipient back to 'pending' so the next cron tick
// picks it up. Allowed when campaign is in: sending, paused, completed_with_errors.
//
// If the campaign was in completed_with_errors, it is reopened to sending so the
// cron resumes processing. This is done inside an explicit transaction so both
// the recipient reset and the optional status change are atomic.
//
// retry_count is intentionally NOT reset — the manual retry counts toward max_retries.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  findCampaignById,
  retryRecipient,
  reopenCampaignToSending,
  insertCampaignAudit,
} from '@/lib/campaign-repo'
import { z } from 'zod'

const UUIDSchema = z.string().uuid()

type Params = { params: Promise<{ id: string; rid: string }> }

const ALLOWED_STATUSES = ['sending', 'paused', 'completed_with_errors'] as const

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/recipients/:rid/retry', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id, rid } = await params

  const idParsed = UUIDSchema.safeParse(id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })

  const ridParsed = UUIDSchema.safeParse(rid)
  if (!ridParsed.success) return NextResponse.json({ error: 'rid inválido' }, { status: 400 })

  const campaignId = idParsed.data
  const recipientId = ridParsed.data

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
          { error: `Retry manual nao permitido (status da campanha: ${campaign.status})` },
          { status: 409 },
        )
      }

      const updated = await retryRecipient(client, campaignId, recipientId)
      if (!updated) {
        await client.query('ROLLBACK')
        return NextResponse.json(
          { error: 'Destinatario nao encontrado ou nao elegivel para nova tentativa' },
          { status: 409 },
        )
      }

      // Reopen completed_with_errors campaigns so the cron picks up pending recipients
      let reopened = false
      if (campaign.status === 'completed_with_errors') {
        reopened = await reopenCampaignToSending(client, campaignId)
      }

      await insertCampaignAudit(client, campaignId, 'recipient_retry_manual', auth.key_id, {
        recipient_id: recipientId,
        campaign_reopened: reopened,
      })

      await client.query('COMMIT')

      log.info({ campaignId, recipientId, reopened }, 'Retry manual agendado')
      return NextResponse.json({ data: updated, campaign_reopened: reopened })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao agendar retry manual')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
