// POST /api/whatsapp/channels/:id/templates/sync
//
// Fetches all message templates from the Meta Graph API for the channel's WABA
// and upserts them into the local whatsapp_templates table.
//
// Only supported for META_CLOUD channels. Requires waba_id in credentials.
// Returns { created, updated, deactivated } counts.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { whatsappTemplateSyncLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findChannelById } from '@/lib/whatsapp/channel-repo'
import { decryptCredentials } from '@/lib/whatsapp/crypto'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import { syncTemplatesInTransaction } from '@/lib/whatsapp/template-repo'
import { ChannelIdSchema } from '@/lib/whatsapp/route-params'
import { RetryableError } from '@/lib/whatsapp/errors'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'POST /api/whatsapp/channels/:id/templates/sync', ip })

  const rateLimit = await whatsappTemplateSyncLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisições de sincronização' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = ChannelIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id inválido' }, { status: 400 })
  const channelId = idParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)

      const channel = await findChannelById(client, channelId)
      if (!channel) return NextResponse.json({ error: 'Canal nao encontrado' }, { status: 404 })
      if (channel.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (channel.provider !== 'META_CLOUD') {
        return NextResponse.json(
          { error: 'Sincronização de templates disponivel apenas para canais META_CLOUD' },
          { status: 409 },
        )
      }

      const creds = decryptCredentials(channel.credentials_encrypted)
      if (!creds.waba_id) {
        return NextResponse.json(
          { error: 'Canal nao possui waba_id configurado -- atualize as credenciais do canal' },
          { status: 422 },
        )
      }
      if (!creds.access_token) {
        return NextResponse.json(
          { error: 'Canal nao possui access_token configurado -- atualize as credenciais do canal' },
          { status: 422 },
        )
      }
      if (!creds.phone_number_id) {
        return NextResponse.json(
          { error: 'Canal nao possui phone_number_id configurado -- atualize as credenciais do canal' },
          { status: 422 },
        )
      }

      const adapter = new MetaAdapter()
      const templates = await adapter.syncTemplates(channel, creds)

      await client.query('BEGIN')
      try {
        const result = await syncTemplatesInTransaction(client, auth.workspace_id, channelId, templates)
        await client.query('COMMIT')
        log.info({ channelId, ...result }, 'Templates sincronizados')
        return NextResponse.json(result, { status: 200 })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    if (err instanceof RetryableError) {
      log.error({ err }, 'Meta indisponivel (RetryableError)')
      return NextResponse.json({ error: 'Meta indisponivel no momento. Tente novamente.' }, { status: 503 })
    }
    log.error({ err }, 'Erro ao sincronizar templates')
    return NextResponse.json({ error: 'Erro interno ao sincronizar. Verifique as credenciais e tente novamente.' }, { status: 500 })
  }
}
