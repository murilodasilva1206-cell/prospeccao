// GET /api/whatsapp/inbox/stream — Server-Sent Events for real-time inbox
//
// Polls DB every POLL_MS, pushes new events:
//   event: message.created        — new inbound message
//   event: message.status.updated — outbound status change or new outbound
//   : heartbeat                   — keepalive comment every HEARTBEAT_MS
//
// Reconnect: Last-Event-ID header or ?since=ISO query param sets cursor.
// Auth: requireWorkspaceAuth (session cookie or Bearer wk_...)
// Rate limit: whatsappInboxLimiter
// Workspace isolation: DB query always filters by workspace_id from auth

import { NextRequest } from 'next/server'
import { requireWorkspaceAuth, authErrorResponse, type AuthContext } from '@/lib/whatsapp/auth-middleware'
import { whatsappInboxLimiter } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/get-ip'
import pool from '@/lib/database'
import { logger } from '@/lib/logger'

const log = logger.child({ route: 'GET /api/whatsapp/inbox/stream' })

const POLL_MS = 2_000
const HEARTBEAT_MS = 15_000

export async function GET(request: NextRequest) {
  const ip = getClientIp(request)
  const rl = await whatsappInboxLimiter.check(ip)
  if (!rl.success) {
    return new Response(JSON.stringify({ error: 'Muitas requisições' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Auth uses a short-lived connection (released before the stream starts)
  const authClient = await pool.connect()
  let auth: AuthContext
  try {
    auth = await requireWorkspaceAuth(request, authClient)
  } catch (err) {
    authClient.release()
    const errRes = authErrorResponse(err)
    if (errRes) return errRes
    return new Response(JSON.stringify({ error: 'Erro interno' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  authClient.release()

  // Cursor for DB query: Last-Event-ID > ?since > 30s ago default
  const lastEventId = request.headers.get('Last-Event-ID')
  const sinceParam = new URL(request.url).searchParams.get('since')
  let cursor = lastEventId ?? sinceParam ?? new Date(Date.now() - 30_000).toISOString()

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      const enqueue = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(chunk)) } catch { /* disconnected */ }
      }

      const sendEvent = (event: string, data: unknown, id: string) => {
        enqueue(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const sendHeartbeat = () => enqueue(': heartbeat\n\n')

      const poll = async () => {
        if (closed) return
        try {
          const client = await pool.connect()
          try {
            const { rows } = await client.query<{
              id: string
              conversation_id: string
              direction: string
              status: string
              body: string | null
              message_type: string
              created_at: string
            }>(
              `SELECT m.id, m.conversation_id, m.direction, m.status,
                      m.body, m.message_type, m.created_at
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE c.workspace_id = $1
                 AND m.created_at > $2
               ORDER BY m.created_at ASC
               LIMIT 50`,
              [auth.workspace_id, cursor],
            )
            for (const row of rows) {
              const eventType =
                row.direction === 'inbound' ? 'message.created' : 'message.status.updated'
              sendEvent(eventType, row, row.id)
              cursor = row.created_at
            }
          } finally {
            client.release()
          }
        } catch (err) {
          log.warn({ err, workspaceId: auth.workspace_id }, '[sse] poll error')
        }
      }

      await poll()

      const pollTimer = setInterval(() => { void poll() }, POLL_MS)
      const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS)

      request.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(pollTimer)
        clearInterval(heartbeatTimer)
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
