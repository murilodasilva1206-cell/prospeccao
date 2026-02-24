// POST /api/campaigns/process — campaign scheduler worker (Vercel Cron or external scheduler, e.g. GitHub Actions)
//
// Finds all campaigns in 'sending' state whose next_send_at has elapsed and
// processes them autonomously — no browser presence required.
//
// Algorithm per campaign:
//   1. Check working hours (skip if outside window); hours are UTC-3 (Brazil).
//   2. Compute to_send = min(10, ceil(60 / delay_seconds)) — recipients per tick.
//   3. Claim 1 recipient at a time via claimPendingRecipients (FOR UPDATE SKIP LOCKED).
//   4. Send via WhatsApp adapter.
//   5. On success: mark sent, increment counter, update next_send_at.
//   6. On RetryableError: scheduleRecipientRetry (backoff 2^n × 30 s, max max_retries).
//   7. On permanent error: mark failed, increment counter.
//   8. When remaining = 0: finalizeCampaign atomically.
//
// Concurrency safety:
//   - findAndClaimSendableCampaigns() uses FOR UPDATE SKIP LOCKED then advances
//     next_send_at by 5 min inside a transaction → concurrent cron runs skip.
//   - claimPendingRecipients() uses FOR UPDATE SKIP LOCKED → no duplicate sends.
//
// Auth: Authorization: Bearer <CRON_SECRET> (constant-time compare).
// Returns 503 if CRON_SECRET is not configured (dev environments without cron).

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import pool from '@/lib/database'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import {
  findAndClaimSendableCampaigns,
  claimPendingRecipients,
  updateRecipientStatus,
  incrementCampaignCounters,
  updateCampaignNextSendAt,
  scheduleRecipientRetry,
  countPendingOrProcessingRecipients,
  finalizeCampaign,
  insertCampaignAudit,
  findCampaignById,
  type Campaign,
  type CampaignRecipient,
} from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { upsertConversation } from '@/lib/whatsapp/conversation-repo'
import { insertMessage } from '@/lib/whatsapp/message-repo'
import { normalizePhoneForWhatsApp, applyMessageTemplate } from '@/lib/agent-humanizer'
import { RetryableError } from '@/lib/whatsapp/errors'
import {
  isWithinWorkingHours,
  computeNextSendAt,
  recipientsThisTick,
} from '@/lib/campaign-automation-utils'

// Max campaigns to process in a single cron invocation
const MAX_CAMPAIGNS_PER_TICK = 10
// Max recipients per campaign per tick (keeps cron execution under ~30 s)
const MAX_RECIPIENTS_PER_CAMPAIGN = 10

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'POST /api/campaigns/process' })

  // ---------------------------------------------------------------------------
  // Auth: CRON_SECRET
  // ---------------------------------------------------------------------------
  if (!env.CRON_SECRET) {
    log.warn('CRON_SECRET nao configurado — endpoint desabilitado')
    return NextResponse.json({ error: 'Cron nao configurado' }, { status: 503 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  let authorized = false
  try {
    const secretBuf = Buffer.from(env.CRON_SECRET, 'utf8')
    const tokenBuf  = Buffer.from(token, 'utf8')
    if (secretBuf.length === tokenBuf.length) {
      authorized = timingSafeEqual(secretBuf, tokenBuf)
    }
  } catch {
    authorized = false
  }

  if (!authorized) {
    log.warn('Tentativa de acesso ao cron com token invalido')
    return NextResponse.json({ error: 'Nao autorizado' }, { status: 401 })
  }

  // ---------------------------------------------------------------------------
  // Find & claim sendable campaigns
  // ---------------------------------------------------------------------------
  const claimClient = await pool.connect()
  let campaigns: Campaign[]
  try {
    campaigns = await findAndClaimSendableCampaigns(claimClient, MAX_CAMPAIGNS_PER_TICK)
  } finally {
    claimClient.release()
  }

  if (campaigns.length === 0) {
    return NextResponse.json({ data: { processed: 0, campaigns: [] } })
  }

  log.info({ count: campaigns.length }, 'Campanhas a processar')

  // ---------------------------------------------------------------------------
  // Process each campaign
  // ---------------------------------------------------------------------------
  const results: Array<{ id: string; sent: number; failed: number; retried: number; status: string }> = []

  for (const campaign of campaigns) {
    // Skip if outside working hours
    if (!isWithinWorkingHours(campaign.automation_working_hours_start, campaign.automation_working_hours_end)) {
      // Re-schedule for next cron tick (1 min) — don't waste the slot
      const rescheduleClient = await pool.connect()
      try {
        await updateCampaignNextSendAt(rescheduleClient, campaign.id, new Date(Date.now() + 60_000))
      } finally {
        rescheduleClient.release()
      }
      log.info({ campaignId: campaign.id }, 'Campanha fora do horario de envio — adiando')
      results.push({ id: campaign.id, sent: 0, failed: 0, retried: 0, status: 'outside_working_hours' })
      continue
    }

    // Load channel + credentials (once per campaign)
    if (!campaign.channel_id || !campaign.message_type || !campaign.message_content) {
      log.warn({ campaignId: campaign.id }, 'Campanha incompleta — pulando')
      results.push({ id: campaign.id, sent: 0, failed: 0, retried: 0, status: 'incomplete' })
      continue
    }

    const channelClient = await pool.connect()
    let channel: Awaited<ReturnType<typeof findChannelById>>
    try {
      channel = await findChannelById(channelClient, campaign.channel_id)
    } finally {
      channelClient.release()
    }

    if (!channel || channel.status !== 'CONNECTED') {
      log.warn({ campaignId: campaign.id, channelId: campaign.channel_id }, 'Canal indisponivel — pulando')
      // Re-schedule in 5 min so we don't loop too fast on a disconnected channel
      const rescheduleClient = await pool.connect()
      try {
        await updateCampaignNextSendAt(rescheduleClient, campaign.id, new Date(Date.now() + 300_000))
      } finally {
        rescheduleClient.release()
      }
      results.push({ id: campaign.id, sent: 0, failed: 0, retried: 0, status: 'channel_unavailable' })
      continue
    }

    const creds = decryptCredentials(channel.credentials_encrypted)
    const adapter = getAdapter(channel.provider)
    const messageContent = campaign.message_content as Record<string, unknown>

    let campaignSent = 0
    let campaignFailed = 0
    let campaignRetried = 0

    // Loop bound is unbounded; each iteration re-reads fresh campaign state and
    // recomputes toSend from the *current* automation config so that a
    // PATCH /automation change (e.g. lower max_per_hour) takes effect mid-tick.
    for (let i = 0; ; i++) {
      // Re-read campaign status and config before each claim
      const checkClient = await pool.connect()
      let fresh: Campaign | null
      try {
        fresh = await findCampaignById(checkClient, campaign.id)
      } finally {
        checkClient.release()
      }
      if (!fresh || fresh.status !== 'sending') {
        log.info({ campaignId: campaign.id, status: fresh?.status }, 'Campanha nao esta mais enviando — interrompendo tick')
        break
      }

      // toSend recalculated from fresh config each iteration
      const toSend = recipientsThisTick(
        fresh.automation_delay_seconds,
        fresh.automation_max_per_hour,
        MAX_RECIPIENTS_PER_CAMPAIGN,
      )
      if (i >= toSend) break

      // Claim the next single recipient
      const claimRecipientClient = await pool.connect()
      let recipient: CampaignRecipient | null = null
      try {
        const claimed = await claimPendingRecipients(claimRecipientClient, campaign.id, 1)
        if (claimed.recoveredCount > 0) {
          log.warn({ campaignId: campaign.id, recoveredCount: claimed.recoveredCount }, 'Lease expirada recuperada')
        }
        recipient = claimed.recipients[0] ?? null
      } finally {
        claimRecipientClient.release()
      }

      if (!recipient) break // No more recipients — campaign is done or all claimed

      const phone = normalizePhoneForWhatsApp(recipient.telefone)
      if (!phone) {
        const skipClient = await pool.connect()
        try {
          await updateRecipientStatus(skipClient, recipient.id, 'skipped', {
            error_message: 'Telefone ausente ou invalido',
          })
        } finally {
          skipClient.release()
        }
        continue
      }

      try {
        let providerMessageId: string | null = null
        let sentBody: string

        if (campaign.message_type === 'template') {
          const result = await adapter.sendTemplate(
            channel,
            creds,
            phone,
            String(messageContent.name ?? ''),
            String(messageContent.language ?? 'pt_BR'),
            Array.isArray(messageContent.body_params) ? (messageContent.body_params as string[]) : [],
          )
          providerMessageId = result.message_id ?? null
          sentBody = `[template:${messageContent.name}]`
        } else {
          const rawBody = String(messageContent.body ?? '')
          const filledBody = applyMessageTemplate(rawBody, {
            razaoSocial: recipient.razao_social ?? undefined,
            nomeFantasia: recipient.nome_fantasia ?? undefined,
            municipio: recipient.municipio ?? undefined,
          })
          const result = await adapter.sendMessage(channel, creds, phone, filledBody)
          providerMessageId = result.message_id ?? null
          sentBody = filledBody
        }

        // Record success
        const sendClient = await pool.connect()
        try {
          await updateRecipientStatus(sendClient, recipient.id, 'sent', {
            provider_message_id: providerMessageId,
            sent_at: new Date(),
          })
          await incrementCampaignCounters(sendClient, campaign.id, { sent: 1 })

          const conv = await upsertConversation(sendClient, {
            channel_id: channel.id,
            workspace_id: campaign.workspace_id,
            contact_phone: phone,
            contact_name: recipient.nome_fantasia ?? recipient.razao_social ?? null,
          })
          await insertMessage(sendClient, {
            conversation_id: conv.id,
            channel_id: channel.id,
            provider_message_id: providerMessageId,
            direction: 'outbound',
            message_type: 'text',
            status: 'sent',
            body: sentBody,
            sent_by: `campaign:${campaign.id}`,
          })
        } finally {
          sendClient.release()
        }

        campaignSent++
      } catch (sendErr) {
        const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr)
        log.warn({ campaignId: campaign.id, recipientId: recipient.id, err: errMsg }, 'Falha ao enviar')

        const failClient = await pool.connect()
        try {
          if (sendErr instanceof RetryableError) {
            // Retryable: schedule retry with backoff (may become permanent failure at max_retries)
            // Use fresh.max_retries so PATCH /automation changes apply immediately.
            const retryOutcome = await scheduleRecipientRetry(
              failClient,
              recipient.id,
              recipient.retry_count,
              fresh.max_retries,
              errMsg.slice(0, 500),
            )
            if (retryOutcome === 'failed') {
              await incrementCampaignCounters(failClient, campaign.id, { failed: 1 })
              campaignFailed++
            } else {
              campaignRetried++
            }
          } else {
            // Permanent failure
            await updateRecipientStatus(failClient, recipient.id, 'failed', {
              error_message: errMsg.slice(0, 500),
            })
            await incrementCampaignCounters(failClient, campaign.id, { failed: 1 })
            campaignFailed++
          }
        } finally {
          failClient.release()
        }
      }

      // Update next_send_at after each send using fresh config so PATCH /automation
      // changes (delay, jitter, max_per_hour) take effect on the next send.
      const nextAt = computeNextSendAt(
        fresh.automation_delay_seconds,
        fresh.automation_jitter_max,
        fresh.automation_max_per_hour,
      )
      const nextSendClient = await pool.connect()
      try {
        await updateCampaignNextSendAt(nextSendClient, campaign.id, nextAt)
      } finally {
        nextSendClient.release()
      }
    }

    // Check if campaign is done
    const remainingClient = await pool.connect()
    let remaining: number
    try {
      remaining = await countPendingOrProcessingRecipients(remainingClient, campaign.id)
    } finally {
      remainingClient.release()
    }

    if (remaining === 0) {
      const finalClient = await pool.connect()
      try {
        const finalized = await finalizeCampaign(finalClient, campaign.id)
        if (finalized) {
          await insertCampaignAudit(finalClient, campaign.id, 'completed', 'cron', {
            status: finalized.status,
            sent: finalized.sent_count,
            failed: finalized.failed_count,
          })
          log.info({ campaignId: campaign.id, status: finalized.status }, 'Campanha finalizada pelo cron')
          results.push({ id: campaign.id, sent: campaignSent, failed: campaignFailed, retried: campaignRetried, status: finalized.status })
        } else {
          // Another concurrent process already finalized
          const current = await findCampaignById(finalClient, campaign.id)
          results.push({ id: campaign.id, sent: campaignSent, failed: campaignFailed, retried: campaignRetried, status: current?.status ?? 'unknown' })
        }
      } finally {
        finalClient.release()
      }
    } else {
      results.push({ id: campaign.id, sent: campaignSent, failed: campaignFailed, retried: campaignRetried, status: 'sending' })
    }
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0)
  log.info({ processed: campaigns.length, totalSent }, 'Cron tick concluido')

  return NextResponse.json({
    data: {
      processed: campaigns.length,
      campaigns: results,
    },
  })
}
