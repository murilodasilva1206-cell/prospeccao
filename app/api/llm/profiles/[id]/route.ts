// PATCH  /api/llm/profiles/:id — update an LLM profile
// DELETE /api/llm/profiles/:id — delete an LLM profile
//
// Auth: session cookie or Bearer wk_... token required.
// workspace_id is always taken from the auth token — never from the request body.

import { NextRequest, NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { updateProfile, deleteProfile } from '@/lib/llm-profile-repo'
import type { LlmProvider } from '@/lib/llm-providers'

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'google'] as const

const LlmProfileUpdateSchema = z.object({
  name:       z.string().trim().min(1).max(100).optional(),
  provider:   z.enum(LLM_PROVIDERS).optional(),
  api_key:    z.string().trim().min(1).max(500).optional(),
  model:      z.string().trim().min(1).max(200).optional(),
  base_url:   z.string().url().nullable().optional(),
  is_default: z.boolean().optional(),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'PATCH /api/llm/profiles/:id', profile_id: id })

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Invalid profile ID' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    const auth = await requireWorkspaceAuth(request, client)

    const body = await request.json()
    const input = LlmProfileUpdateSchema.parse(body)

    const updated = await updateProfile(client, id, auth.workspace_id, {
      name:       input.name,
      provider:   input.provider as LlmProvider | undefined,
      api_key:    input.api_key,
      model:      input.model,
      base_url:   input.base_url,
      is_default: input.is_default,
    })

    if (!updated) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 })
    }

    log.info({ workspace_id: auth.workspace_id }, 'LLM profile updated')
    return NextResponse.json({ data: updated })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Validation error', details: err.issues }, { status: 400 })
    }
    if (err instanceof Error && err.message.includes('unique')) {
      return NextResponse.json({ error: 'Já existe um perfil com esse nome neste workspace' }, { status: 409 })
    }
    if ((err as { code?: string }).code === '42P01') {
      return NextResponse.json({ error: 'Tabela llm_profiles não encontrada. Execute a migration 015.' }, { status: 500 })
    }
    log.error({ err }, 'PATCH /api/llm/profiles/:id error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    client.release()
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'DELETE /api/llm/profiles/:id', profile_id: id })

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Invalid profile ID' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    const auth = await requireWorkspaceAuth(request, client)

    const deleted = await deleteProfile(client, id, auth.workspace_id)

    if (!deleted) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 })
    }

    log.info({ workspace_id: auth.workspace_id }, 'LLM profile deleted')
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })
    if ((err as { code?: string }).code === '42P01') {
      return NextResponse.json({ error: 'Tabela llm_profiles não encontrada. Execute a migration 015.' }, { status: 500 })
    }
    log.error({ err }, 'DELETE /api/llm/profiles/:id error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    client.release()
  }
}
