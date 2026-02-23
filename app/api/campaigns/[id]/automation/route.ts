// PATCH /api/campaigns/:id/automation — update automation config mid-execution
//
// Allowed from: sending | paused
//
// Only fields provided in the request body are updated. The new config applies
// to the very next recipient send (the current in-progress send is unaffected).

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { campaignLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import { requireWorkspaceAuth, authErrorResponse } from '@/lib/whatsapp/auth-middleware'
import { findCampaignById, updateAutomationConfig, insertCampaignAudit } from '@/lib/campaign-repo'
import { UpdateAutomationSchema } from '@/lib/schemas'
import { z } from 'zod'

const CampaignIdSchema = z.string().uuid()

const UPDATABLE_STATUSES = new Set(['sending', 'paused'])

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const requestId = crypto.randomUUID()
  const ip = getClientIp(request)
  const log = logger.child({ requestId, route: 'PATCH /api/campaigns/:id/automation', ip })

  const rateLimit = await campaignLimiter.check(ip)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Muitas requisicoes' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
    )
  }

  const idParsed = CampaignIdSchema.safeParse((await params).id)
  if (!idParsed.success) return NextResponse.json({ error: 'id invalido' }, { status: 400 })
  const campaignId = idParsed.data

  const body = await request.json().catch(() => ({}))
  const patchParsed = UpdateAutomationSchema.safeParse(body)
  if (!patchParsed.success) {
    return NextResponse.json(
      { error: 'Configuracao invalida', details: patchParsed.error.issues },
      { status: 400 },
    )
  }
  const patch = patchParsed.data

  try {
    const client = await pool.connect()
    try {
      const auth = await requireWorkspaceAuth(request, client)
      const campaign = await findCampaignById(client, campaignId)

      if (!campaign) return NextResponse.json({ error: 'Campanha nao encontrada' }, { status: 404 })
      if (campaign.workspace_id !== auth.workspace_id) {
        return NextResponse.json({ error: 'Acesso negado' }, { status: 403 })
      }
      if (!UPDATABLE_STATUSES.has(campaign.status)) {
        return NextResponse.json(
          { error: `Configuracao so pode ser alterada enquanto a campanha esta em execucao (status: ${campaign.status})` },
          { status: 409 },
        )
      }

      const updated = await updateAutomationConfig(client, campaignId, patch)
      if (!updated) {
        return NextResponse.json(
          { error: 'Campanha foi modificada concorrentemente — tente novamente' },
          { status: 409 },
        )
      }

      await insertCampaignAudit(client, campaignId, 'automation_config_updated', auth.key_id, patch as Record<string, unknown>)

      log.info({ campaignId, patch }, 'Configuracao de automacao atualizada')
      return NextResponse.json({ data: updated })
    } finally {
      client.release()
    }
  } catch (err) {
    const res = authErrorResponse(err)
    if (res) return res
    log.error({ err }, 'Erro ao atualizar configuracao de automacao')
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
