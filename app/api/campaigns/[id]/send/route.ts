// POST /api/campaigns/:id/send — legacy synchronous batch sender
//
// NOTE: For new integrations use the automation flow instead:
//   POST /api/campaigns/:id/start  — begin cron-driven automated sending
//   POST /api/campaigns/:id/pause  — pause automation
//   POST /api/campaigns/:id/resume — resume automation
//
// This endpoint is restricted to campaigns in status=ready_to_send only.
// Campaigns already in 'sending' (automation running) return 409 to prevent
// mixing the two send paths and bypassing configured delays/pauses.
//
// Security:
//   - Validates workspace ownership before accessing channel credentials.
//   - Idempotent per recipient (CNPJ unique index prevents duplicate DB rows).
//   - Individual recipient failures do not abort the entire campaign.
//   - Audit entry on every send attempt.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignSendLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import {
  findCampaignById,
  claimPendingRecipients,
  updateCampaignStatus,
  updateRecipientStatus,
  incrementCampaignCounters,
  insertCampaignAudit,
  countPendingOrProcessingRecipients,
  finalizeCampaign,
  type CampaignRecipient,
} from '@/lib/campaign-repo'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { upsertConversation } from '@/lib/whatsapp/conversation-repo'
import { insertMessage } from '@/lib/whatsapp/message-repo'
import { normalizePhoneForWhatsApp, applyMessageTemplate } from '@/lib/agent-humanizer'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

// Max recipients to process per request to stay within route timeout
const BATCH_SIZE = 100

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/campaigns/:id/send', ip })

  const rateLimit = await campaignSendLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = CampaignIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const campaignId = idParsed.data

  // Use a separate pool client for the auth check, then work with the campaign
  try {
    const authClient = await pool.connect()
    let auth: { workspace_id: string; key_id: string; actor: string }
    let campaign: Awaited<ReturnType<typeof findCampaignById>>

    try {
      auth = await requireWorkspaceAuth(request, authClient)
      campaign = await findCampaignById(authClient, campaignId)
    } finally {
      authClient.release()
    }

    if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
    if (campaign.workspace_id !== auth.workspace_id) {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
    }
    if (campaign.status === 'sending') {
      return NextResponse.json(
        { error: 'Campanha ja iniciada via automacao — use /pause, /resume ou /cancel em vez de /send' },
        { status: 409 },
      )
    }
    if (campaign.status !== 'ready_to_send') {
      return NextResponse.json(
        { error: `Campanha nao pode ser enviada (status: ${campaign.status})` },
        { status: 409 },
      )
    }
    if (!campaign.channel_id || !campaign.message_type || !campaign.message_content) {
      return NextResponse.json({ error: 'Campanha incompleta — canal ou mensagem ausente' }, { status: 409 })
    }

    // Get channel + credentials
    const channelClient = await pool.connect()
    let channel: Awaited<ReturnType<typeof findChannelById>>
    try {
      channel = await findChannelById(channelClient, campaign.channel_id)
    } finally {
      channelClient.release()
    }

    if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
    if (channel.status !== 'CONNECTED') {
      return NextResponse.json({ error: `Canal não está conectado (status: ${channel.status})` }, { status: 409 })
    }

    // Mark campaign as 'sending'
    if (campaign.status === 'ready_to_send') {
      const updateClient = await pool.connect()
      try {
        await updateCampaignStatus(updateClient, campaignId, 'sending')
        await insertCampaignAudit(updateClient, campaignId, 'sending_started', auth.key_id, {
          total: campaign.total_count,
        })
      } finally {
        updateClient.release()
      }
    }

    // Decrypt credentials once (outside the per-recipient loop)
    const creds = decryptCredentials(channel.credentials_encrypted)
    const adapter = getAdapter(channel.provider)
    const messageContent = campaign.message_content as Record<string, unknown>

    // Atomically claim pending recipients (up to BATCH_SIZE) to avoid duplicate sends
    // under concurrent POST /send requests.
    const recipientsClient = await pool.connect()
    let recipients: CampaignRecipient[]
    try {
      const claimed = await claimPendingRecipients(recipientsClient, campaignId, BATCH_SIZE)
      recipients = claimed.recipients
      if (claimed.recoveredCount > 0) {
        log.warn(
          { campaignId, recoveredCount: claimed.recoveredCount },
          'Re-claimed expired processing recipients — previous worker may have crashed',
        )
      }
    } finally {
      recipientsClient.release()
    }

    log.info({ campaignId, recipientCount: recipients.length }, 'Iniciando envio em lote')

    let batchSent = 0
    let batchFailed = 0

    // Process each recipient sequentially
    for (const recipient of recipients) {
      const phone = normalizePhoneForWhatsApp(recipient.telefone)
      if (!phone) {
        // Skip recipients with invalid/missing phone numbers
        const skipClient = await pool.connect()
        try {
          await updateRecipientStatus(skipClient, recipient.id, 'skipped', {
            error_message: 'Telefone ausente ou inválido',
          })
        } finally {
          skipClient.release()
        }
        continue
      }

      try {
        let providerMessageId: string | null = null
        // sentBody is used for the conversation audit record.
        // For text messages we store the fully-resolved body (placeholders replaced),
        // not the raw template, so the inbox history matches what the contact received.
        let sentBody: string

        if (campaign.message_type === 'template') {
          // Meta Cloud API — send approved template
          const result = await adapter.sendTemplate(
            channel,
            creds,
            phone,
            String(messageContent.name ?? ''),
            String(messageContent.language ?? 'pt_BR'),
            Array.isArray(messageContent.body_params) ? messageContent.body_params as string[] : [],
          )
          providerMessageId = result.message_id ?? null
          sentBody = `[template:${messageContent.name}]`
        } else {
          // Text message — apply placeholders from recipient data
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
          await incrementCampaignCounters(sendClient, campaignId, { sent: 1 })

          // Upsert conversation + audit message
          const conv = await upsertConversation(sendClient, {
            channel_id: channel.id,
            workspace_id: auth.workspace_id,
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
            sent_by: `campaign:${campaignId}`,
          })
        } finally {
          sendClient.release()
        }

        batchSent++
      } catch (sendErr) {
        const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr)
        log.warn({ recipientId: recipient.id, cnpj: recipient.cnpj, err: errMsg }, 'Falha ao enviar para destinatario')

        const failClient = await pool.connect()
        try {
          await updateRecipientStatus(failClient, recipient.id, 'failed', {
            error_message: errMsg.slice(0, 500),
          })
          await incrementCampaignCounters(failClient, campaignId, { failed: 1 })
        } finally {
          failClient.release()
        }

        batchFailed++
      }
    }

    // Check if there are more recipients still to be processed.
    // Must count both 'pending' (unclaimed) and 'processing' (claimed by a concurrent request)
    // so that one request doesn't finalize the campaign while another is still sending.
    const remainingClient = await pool.connect()
    let remainingPending: number
    try {
      remainingPending = await countPendingOrProcessingRecipients(remainingClient, campaignId)
    } finally {
      remainingClient.release()
    }

    // Finalize campaign when all recipients are processed.
    // Uses a single atomic UPDATE that reads the live failed_count from the DB,
    // eliminating the stale-counter bug that could mark a campaign 'completed'
    // while a concurrent request was still recording failures.
    // The WHERE status='sending' guard ensures only one concurrent request wins.
    let finalStatus: 'sending' | 'completed' | 'completed_with_errors' = 'sending'
    if (remainingPending === 0) {
      const finalClient = await pool.connect()
      try {
        const finalized = await finalizeCampaign(finalClient, campaignId)
        if (finalized) {
          // This request won the finalization race — write the audit entry.
          finalStatus = finalized.status as 'completed' | 'completed_with_errors'
          await insertCampaignAudit(finalClient, campaignId, 'completed', auth.key_id, {
            status: finalStatus,
            sent: finalized.sent_count,
            failed: finalized.failed_count,
          })
        } else {
          // Another concurrent request already finalized — re-read the real status.
          const current = await findCampaignById(finalClient, campaignId)
          if (current?.status === 'completed' || current?.status === 'completed_with_errors') {
            finalStatus = current.status
          } else {
            finalStatus = 'sending'
          }
        }
      } finally {
        finalClient.release()
      }
    }

    log.info(
      { campaignId, batchSent, batchFailed, remainingPending, finalStatus },
      'Lote de envio concluido',
    )

    return NextResponse.json({
      data: {
        campaign_id: campaignId,
        status: finalStatus,
        batch_sent: batchSent,
        batch_failed: batchFailed,
        remaining_pending: remainingPending,
        completed: finalStatus !== 'sending',
      },
    })
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    logger.error({ err, campaignId }, 'Erro critico no envio da campanha')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
