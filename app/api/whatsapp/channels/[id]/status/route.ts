// GET /api/whatsapp/channels/:id/status — poll connection status from provider

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { findChannelById, updateChannelStatus } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'GET /api/whatsapp/channels/:id/status', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const { id } = await params

  try {
    const client = await pool.connect()
    try {
      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)
      const status = await adapter.getConnectionStatus(channel, creds)

      // Keep DB in sync with provider status
      if (status !== channel.status) {
        await updateChannelStatus(client, channel.id, status, { last_seen_at: new Date() })
      }

      log.debug({ channelId: id, status }, 'Status consultado')

      return NextResponse.json({
        data: {
          channel_id: id,
          status,
          provider: channel.provider,
          phone_number: channel.phone_number,
          last_seen_at: channel.last_seen_at,
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    log.error({ err }, 'Erro ao consultar status do canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
