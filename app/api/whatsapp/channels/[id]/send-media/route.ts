// POST /api/whatsapp/channels/:id/send-media — send media message (image/audio/video/document/sticker)
//
// Body: multipart/form-data with fields: to, type, file, caption?
// Auth: Bearer wk_... workspace API key
// Security: MIME allowlist + magic bytes + size limit + filename sanitization

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappMediaLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { SendMediaSchema } from '@/lib/schemas'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { validateMediaFile, uploadMedia } from '@/lib/whatsapp/media'
import { env } from '@/lib/env'
import { insertMessage } from '@/lib/whatsapp/message-repo'
import { upsertConversation } from '@/lib/whatsapp/conversation-repo'
import { insertAuditEvent } from '@/lib/whatsapp/audit-repo'
import type { MessageType } from '@/lib/whatsapp/types'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/send-media', ip })

  const rateLimit = await whatsappMediaLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  // UUID validation before feature flag: invalid route → 400 regardless of env
  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const channelId = idParsed.data

  if (!env.MEDIA_STORAGE_ENABLED) {
    return NextResponse.json(
      { error: 'Armazenamento de midia não está ativado neste ambiente' },
      { status: 503 },
    )
  }

  try {
    const client = await pool.connect()
    try {
      // Auth
      const auth = await requireWorkspaceAuth(request, client).catch((e) => { throw e })

      // Load channel — verify ownership
      const channel = await findChannelById(client, channelId)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      // Parse multipart form data
      let formData: FormData
      try {
        formData = await request.formData()
      } catch {
        return NextResponse.json({ error: 'Body deve ser multipart/form-data' }, { status: 400 })
      }

      // Validate text fields
      let fields
      try {
        fields = SendMediaSchema.parse({
          to: formData.get('to'),
          type: formData.get('type'),
          caption: formData.get('caption') ?? undefined,
        })
      } catch (err) {
        if (err instanceof ZodError) {
          return NextResponse.json({ error: 'Parâmetros inválidos', details: err.issues }, { status: 400 })
        }
        throw err
      }

      // Extract file
      const fileField = formData.get('file')
      if (!fileField || !(fileField instanceof File)) {
        return NextResponse.json({ error: 'Campo file e obrigatorio' }, { status: 400 })
      }

      const arrayBuffer = await fileField.arrayBuffer()
      const mediaBuffer = Buffer.from(arrayBuffer)
      const declaredMime = fileField.type || 'application/octet-stream'
      const originalFilename = fileField.name || `upload.${fields.type}`

      // Validate: MIME allowlist + magic bytes + size
      let mediaInfo: { mime: string; size: number; ext: string }
      try {
        mediaInfo = validateMediaFile(mediaBuffer, declaredMime)
      } catch (err) {
        // Log the detailed error server-side; never expose internals to the caller
        log.warn({ err, declaredMime, size: mediaBuffer.length }, 'Arquivo rejeitado na validacao')
        return NextResponse.json({ error: 'Arquivo inválido' }, { status: 400 })
      }

      // Upload to S3
      const { s3Key } = await uploadMedia(mediaBuffer, mediaInfo.mime, originalFilename, channelId)

      // Send via provider adapter
      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)

      let sendResult: { message_id: string }
      if (fields.type === 'sticker') {
        sendResult = await adapter.sendSticker(channel, creds, fields.to, mediaBuffer)
      } else if (fields.type === 'audio') {
        sendResult = await adapter.sendAudio(channel, creds, fields.to, mediaBuffer)
      } else {
        sendResult = await adapter.sendMedia(channel, creds, fields.to, mediaBuffer, mediaInfo.mime, originalFilename, fields.caption)
      }

      // Upsert conversation + persist message
      const conversation = await upsertConversation(client, {
        channel_id: channelId,
        workspace_id: auth.workspace_id,
        contact_phone: fields.to,
        contact_name: null,
      })

      const message = await insertMessage(client, {
        conversation_id: conversation.id,
        channel_id: channelId,
        provider_message_id: sendResult.message_id,
        direction: 'outbound',
        message_type: fields.type as MessageType,
        status: 'sent',
        body: fields.caption ?? null,
        media_s3_key: s3Key,
        media_mime_type: mediaInfo.mime,
        media_filename: originalFilename,
        media_size_bytes: mediaInfo.size,
        sent_by: `human:${auth.key_id}`,
      })

      await insertAuditEvent(client, {
        workspace_id: auth.workspace_id,
        actor: auth.actor,
        action: 'media.uploaded',
        resource_type: 'message',
        resource_id: message.id,
        ip,
      })

      log.info({ channelId, messageId: message.id, type: fields.type }, 'Media enviada')
      return NextResponse.json({ data: { id: message.id, provider_message_id: sendResult.message_id } }, { status: 201 })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao enviar media')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
