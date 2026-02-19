// POST /api/whatsapp/channels/:id/disconnect — log out from WhatsApp provider
// Auth: Bearer wk_... workspace API key required.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappChannelLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { findChannelById, updateChannelStatus } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { getAdapter } from '@/lib/whatsapp/adapters/factory'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/disconnect', ip })

  const rateLimit = await whatsappChannelLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes — tente novamente em breve' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
  const id = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, id)
      if (!channel) {
        return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      }
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      const adapter = getAdapter(channel.provider)

      // Best-effort provider logout (Evolution/UAZAPI DELETE instance; Meta no-op)
      await adapter.disconnect(channel, creds)

      await updateChannelStatus(client, channel.id, 'DISCONNECTED', {
        last_seen_at: new Date(),
      })

      log.info({ channelId: id }, 'Canal desconectado')

      return NextResponse.json({
        data: {
          channel_id: id,
          status: 'DISCONNECTED',
        },
      })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao desconectar canal')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
