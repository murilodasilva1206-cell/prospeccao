// GET|POST /api/campaigns/reconcile-delivery — delivery timeout watchdog (Vercel Cron)
//
// Vercel Cron invokes via GET; POST is kept for manual/curl invocation.
// Both verbs share the same handler.
//
// Finds all campaign recipients that have been in 'sent' status for longer than
// DELIVERY_TIMEOUT_MINUTES without a delivery confirmation, and marks them as
// 'failed' with reason 'timeout_sem_entrega'.
//
// Delivery is considered confirmed when:
//   1. campaign_recipients.delivered_at IS NOT NULL (set by webhook-handler on
//      message.delivered or message.read events), OR
//   2. As a belt-and-suspenders fallback: a matching outbound message row in the
//      messages table has status IN ('delivered', 'read').
//
// Condition (1) is the fast path (indexed column).
// Condition (2) is the safety net for messages sent before migration 022 or if the
// webhook came in but delivered_at was not set due to a transient error.
//
// Counter protection: uses GREATEST(n, 0) to prevent sent_count from going negative
// if counters get out of sync (e.g. from a previous bug or manual DB correction).
//
// Runs every 5 minutes via vercel.json cron schedule.
// Auth: Authorization: Bearer <CRON_SECRET> (same secret as /api/campaigns/process).
// Returns 503 if CRON_SECRET is not configured (dev environments without cron).

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import pool from '@/lib/database'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

async function handler(request: NextRequest): Promise<NextResponse> {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET nao configurado' }, { status: 503 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  let valid = false
  try {
    valid =
      token.length === env.CRON_SECRET.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(env.CRON_SECRET))
  } catch {
    valid = false
  }
  if (!valid) {
    return NextResponse.json({ error: 'Nao autorizado' }, { status: 401 })
  }

  if (env.DELIVERY_TIMEOUT_MINUTES === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'watchdog_disabled' })
  }

  const client = await pool.connect()
  try {
    // Mark timed-out recipients and adjust campaign counters atomically.
    //
    // A recipient is timed out only when ALL of these hold:
    //   1. status = 'sent'
    //   2. sent_at older than DELIVERY_TIMEOUT_MINUTES
    //   3. delivered_at IS NULL (fast path: no delivery confirmation recorded)
    //   4. No matching outbound message with status delivered/read in messages table
    //      (safety net for rows sent before migration 022 or after a transient error)
    //
    // Counter fix uses GREATEST(…, 0) to prevent negative sent_count under any
    // circumstance (double-run protection or manual DB corrections).
    //
    // Idempotent: re-running produces no extra updates (WHERE status='sent' guard).
    const { rows } = await client.query(
      `WITH timed_out AS (
         UPDATE campaign_recipients cr
         SET status        = 'failed',
             error_message = 'timeout_sem_entrega'
         WHERE cr.status      = 'sent'
           AND cr.sent_at IS NOT NULL
           AND cr.sent_at < NOW() - ($1 * INTERVAL '1 minute')
           AND cr.delivered_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM messages m
             JOIN campaigns c ON c.id = cr.campaign_id
             WHERE m.channel_id          = c.channel_id
               AND m.provider_message_id = cr.provider_message_id
               AND m.status IN ('delivered', 'read')
           )
         RETURNING cr.campaign_id, cr.id
       ),
       counter_updates AS (
         SELECT campaign_id, COUNT(*)::int AS cnt
         FROM timed_out
         GROUP BY campaign_id
       )
       UPDATE campaigns
       SET sent_count   = GREATEST(sent_count   - cu.cnt, 0),
           failed_count = failed_count + cu.cnt
       FROM counter_updates cu
       WHERE campaigns.id = cu.campaign_id
       RETURNING campaigns.id, cu.cnt AS timed_out_count`,
      [env.DELIVERY_TIMEOUT_MINUTES],
    )

    const totalTimedOut = rows.reduce((sum: number, r: Record<string, unknown>) => sum + Number(r.timed_out_count ?? 0), 0)

    if (totalTimedOut > 0) {
      logger.warn(
        { campaigns: rows.map((r: Record<string, unknown>) => ({ id: r.id, count: r.timed_out_count })) },
        `Watchdog: ${totalTimedOut} destinatario(s) marcados como timeout_sem_entrega`,
      )
    } else {
      logger.debug('Watchdog: nenhum destinatario com timeout')
    }

    return NextResponse.json({ ok: true, timed_out: totalTimedOut })
  } catch (err) {
    logger.error({ err }, 'Erro no watchdog de entrega')
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  } finally {
    client.release()
  }
}

// Vercel Cron fires GET; keep POST for manual/curl invocation.
export const GET  = handler
export const POST = handler
