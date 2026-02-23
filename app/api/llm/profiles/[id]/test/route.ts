// POST /api/llm/profiles/:id/test — test connectivity of an LLM profile
//
// Makes a minimal call (max_tokens=5) to verify the API key and model are valid.
// Returns { ok: true, latencyMs } on success or { ok: false, error } on failure.
// The raw API key is never returned.

import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'
import { requireWorkspaceAuth, AuthError } from '@/lib/whatsapp/auth-middleware'
import { getProfileConfig } from '@/lib/llm-profile-repo'
import { callLlmProvider } from '@/lib/llm-providers'

const TEST_SYSTEM_PROMPT = 'You are a test assistant. Respond with exactly: {"ok":true}'
const TEST_USER_MESSAGE = 'Respond with {"ok":true}'
const TEST_TIMEOUT_MS = 10_000

type RouteParams = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const requestId = crypto.randomUUID()
  const log = logger.child({ requestId, route: 'POST /api/llm/profiles/:id/test', profile_id: id })

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Invalid profile ID' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    const auth = await requireWorkspaceAuth(request, client)

    const config = await getProfileConfig(client, id, auth.workspace_id)
    if (!config) {
      return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 })
    }

    const startTime = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)

    try {
      await callLlmProvider(
        config,
        TEST_SYSTEM_PROMPT,
        TEST_USER_MESSAGE,
        10,   // max_tokens: minimal
        0.0,  // temperature: deterministic
        controller.signal,
      )
      clearTimeout(timer)

      const latencyMs = Date.now() - startTime
      log.info({ workspace_id: auth.workspace_id, latencyMs }, 'LLM profile test succeeded')
      return NextResponse.json({ ok: true, latencyMs })
    } catch (callErr) {
      clearTimeout(timer)
      const errMsg = callErr instanceof Error ? callErr.message : 'Unknown error'
      log.warn({ workspace_id: auth.workspace_id, err: errMsg }, 'LLM profile test failed')
      return NextResponse.json({ ok: false, error: errMsg })
    }
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })
    log.error({ err }, 'POST /api/llm/profiles/:id/test error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    client.release()
  }
}
