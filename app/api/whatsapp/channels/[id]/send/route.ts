// POST /api/whatsapp/channels/:id/send — send a text message via the channel

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappSendLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { SendMessageSchema } from '@/lib/schemas'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/send', ip })

  const rateLimit = await whatsappSendLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Corpo da requisicao nao e JSON valido' }, { status: 400 })
  }

  const parsed = SendMessageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Dados invalidos' },
      { status: 400 },
    )
  }

  const { to, message } = parsed.data

  try {
    const client = await pool.connect()
    try {
      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }

      if (channel.status !== 'CONNECTED') {
        return NextResponse.json(
          { error: `Canal nao esta conectado (status atual: ${channel.status})` },
          { status: 409 },
        )
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)
      const result = await adapter.sendMessage(channel, creds, to, message)

      log.info({ channelId: id, to }, 'Mensagem enviada')

      return NextResponse.json({
        data: {
          channel_id: id,
          message_id: result.message_id,
          to,
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro ao enviar mensagem')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
