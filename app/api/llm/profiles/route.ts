// GET  /api/llm/profiles — list LLM profiles for the authenticated workspace
// POST /api/llm/profiles — create a new LLM profile
//
// Auth: session cookie or Bearer wk_... token required.
// workspace_id is always taken from the auth token — never from the request body.

import { NextRequest, NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { listProfiles, createProfile } from '@/lib/llm-profile-repo'
import type { LlmProvider } from '@/lib/llm-providers'

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'google'] as const

const LlmProfileCreateSchema = z.object({
  name:       z.string().trim().min(1).max(100),
  provider:   z.enum(LLM_PROVIDERS),
  api_key:    z.string().trim().min(1).max(500),
  model:      z.string().trim().min(1).max(200),
  base_url:   z.string().url().optional().nullable(),
  is_default: z.boolean().optional().default(false),
})

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'GET /api/llm/profiles' })

  const client = await pool.connect()
  try {
    const auth = await requireWorkspaceAuth(request, client)
    const profiles = await listProfiles(client, auth.workspace_id)

    log.info({ workspace_id: auth.workspace_id, count: profiles.length }, 'LLM profiles listed')
    return NextResponse.json({ data: profiles })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })
    if ((err as { code?: string }).code === '42P01') {
      return NextResponse.json({ error: 'Tabela llm_profiles não encontrada. Execute a migration 015.' }, { status: 500 })
    }
    log.error({ err }, 'GET /api/llm/profiles error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    client.release()
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'POST /api/llm/profiles' })

  const client = await pool.connect()
  try {
    const auth = await requireWorkspaceAuth(request, client)

    const body = await request.json()
    const input = LlmProfileCreateSchema.parse(body)

    const profile = await createProfile(client, auth.workspace_id, {
      name:       input.name,
      provider:   input.provider as LlmProvider,
      api_key:    input.api_key,
      model:      input.model,
      base_url:   input.base_url ?? null,
      is_default: input.is_default,
    })

    log.info({ workspace_id: auth.workspace_id, profile_id: profile.id }, 'LLM profile created')
    return NextResponse.json({ data: profile }, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'Validation error', details: err.issues }, { status: 400 })
    }
    // Unique constraint: duplicate name
    if (err instanceof Error && err.message.includes('unique')) {
      return NextResponse.json({ error: 'Já existe um perfil com esse nome neste workspace' }, { status: 409 })
    }
    if ((err as { code?: string }).code === '42P01') {
      return NextResponse.json({ error: 'Tabela llm_profiles não encontrada. Execute a migration 015.' }, { status: 500 })
    }
    log.error({ err }, 'POST /api/llm/profiles error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    client.release()
  }
}
