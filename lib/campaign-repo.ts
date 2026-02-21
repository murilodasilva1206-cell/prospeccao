// ---------------------------------------------------------------------------
// Campaign repository — all DB access for campaigns, campaign_recipients,
// and campaign_audit_log tables.
// Only parameterized SQL ($N). Never interpolates user input into query text.
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { CampaignStatus, CampaignRecipientInput, AutomationConfig, UpdateAutomation } from '@/lib/schemas'
import { env } from '@/lib/env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Campaign {
  id: string
  workspace_id: string
  name: string | null
  status: CampaignStatus
  channel_id: string | null
  message_type: 'template' | 'text' | null
  message_content: Record<string, unknown> | null
  search_filters: Record<string, unknown> | null
  total_count: number
  sent_count: number
  failed_count: number
  confirmation_token: string | null
  created_by: string
  created_at: Date
  updated_at: Date
  // Automation
  automation_delay_seconds: number
  automation_jitter_max: number
  automation_max_per_hour: number
  automation_working_hours_start: number | null
  automation_working_hours_end: number | null
  max_retries: number
  next_send_at: Date | null
  paused_at: Date | null
}

export interface CampaignRecipient {
  id: string
  campaign_id: string
  cnpj: string
  razao_social: string | null
  nome_fantasia: string | null
  telefone: string | null
  email: string | null
  municipio: string | null
  uf: string | null
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped'
  provider_message_id: string | null
  error_message: string | null
  sent_at: Date | null
  processing_started_at: Date | null
  retry_count: number
  next_retry_at: Date | null
  created_at: Date
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToCampaign(row: Record<string, unknown>): Campaign {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: (row.name as string | null) ?? null,
    status: row.status as CampaignStatus,
    channel_id: (row.channel_id as string | null) ?? null,
    message_type: (row.message_type as 'template' | 'text' | null) ?? null,
    message_content: (row.message_content as Record<string, unknown> | null) ?? null,
    search_filters: (row.search_filters as Record<string, unknown> | null) ?? null,
    total_count: Number(row.total_count ?? 0),
    sent_count: Number(row.sent_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    confirmation_token: (row.confirmation_token as string | null) ?? null,
    created_by: row.created_by as string,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
    // Automation (defaults match migration 014 column defaults)
    automation_delay_seconds: Number(row.automation_delay_seconds ?? 120),
    automation_jitter_max: Number(row.automation_jitter_max ?? 20),
    automation_max_per_hour: Number(row.automation_max_per_hour ?? 30),
    automation_working_hours_start: row.automation_working_hours_start != null ? Number(row.automation_working_hours_start) : null,
    automation_working_hours_end: row.automation_working_hours_end != null ? Number(row.automation_working_hours_end) : null,
    max_retries: Number(row.max_retries ?? 3),
    next_send_at: row.next_send_at ? new Date(row.next_send_at as string) : null,
    paused_at: row.paused_at ? new Date(row.paused_at as string) : null,
  }
}

function rowToRecipient(row: Record<string, unknown>): CampaignRecipient {
  return {
    id: row.id as string,
    campaign_id: row.campaign_id as string,
    cnpj: row.cnpj as string,
    razao_social: (row.razao_social as string | null) ?? null,
    nome_fantasia: (row.nome_fantasia as string | null) ?? null,
    telefone: (row.telefone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    municipio: (row.municipio as string | null) ?? null,
    uf: (row.uf as string | null) ?? null,
    status: row.status as 'pending' | 'processing' | 'sent' | 'failed' | 'skipped',
    provider_message_id: (row.provider_message_id as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    sent_at: row.sent_at ? new Date(row.sent_at as string) : null,
    processing_started_at: row.processing_started_at ? new Date(row.processing_started_at as string) : null,
    retry_count: Number(row.retry_count ?? 0),
    next_retry_at: row.next_retry_at ? new Date(row.next_retry_at as string) : null,
    created_at: new Date(row.created_at as string),
  }
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

interface CreateCampaignInput {
  workspace_id: string
  name: string | null
  search_filters: Record<string, unknown> | null
  total_count: number
  created_by: string
  confirmation_token: string
}

export async function createCampaign(
  client: PoolClient,
  input: CreateCampaignInput,
): Promise<Campaign> {
  const { rows } = await client.query(
    `INSERT INTO campaigns
       (workspace_id, name, status, search_filters, total_count, created_by, confirmation_token)
     VALUES ($1, $2, 'draft', $3, $4, $5, $6)
     RETURNING *`,
    [
      input.workspace_id,
      input.name ?? null,
      input.search_filters ? JSON.stringify(input.search_filters) : null,
      input.total_count,
      input.created_by,
      input.confirmation_token,
    ],
  )
  return rowToCampaign(rows[0])
}

export async function findCampaignById(
  client: PoolClient,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [id],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

export async function findCampaignsByWorkspace(
  client: PoolClient,
  workspace_id: string,
  limit = 20,
  offset = 0,
): Promise<Campaign[]> {
  // confirmation_token is intentionally excluded — it is single-use and must not
  // be exposed after creation. GET /api/campaigns/:id also omits it.
  const { rows } = await client.query(
    `SELECT id, workspace_id, name, status, channel_id, message_type, message_content,
            search_filters, total_count, sent_count, failed_count,
            created_by, created_at, updated_at
     FROM campaigns
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [workspace_id, limit, offset],
  )
  return rows.map(rowToCampaign)
}

/** Transition campaign to a new status (with optional field updates). */
export async function updateCampaignStatus(
  client: PoolClient,
  id: string,
  status: CampaignStatus,
  extra: {
    channel_id?: string | null
    message_type?: 'template' | 'text' | null
    message_content?: Record<string, unknown> | null
    /** When true, sets message_type and message_content to NULL regardless of COALESCE.
     *  Use when re-selecting the channel so the previous message is cleared. */
    resetMessageFields?: boolean
    confirmation_token?: string | null
    sent_count?: number
    failed_count?: number
  } = {},
): Promise<Campaign | null> {
  const reset = extra.resetMessageFields ?? false
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status             = $2,
         channel_id         = COALESCE($3, channel_id),
         message_type       = CASE WHEN $9 THEN NULL ELSE COALESCE($4, message_type) END,
         message_content    = CASE WHEN $9 THEN NULL ELSE COALESCE($5, message_content) END,
         confirmation_token = $6,
         sent_count         = COALESCE($7, sent_count),
         failed_count       = COALESCE($8, failed_count)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      extra.channel_id ?? null,
      extra.message_type ?? null,
      extra.message_content ? JSON.stringify(extra.message_content) : null,
      extra.confirmation_token !== undefined ? extra.confirmation_token : undefined,
      extra.sent_count ?? null,
      extra.failed_count ?? null,
      reset,
    ],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/**
 * Atomically cancel a campaign if it is still in a cancellable status.
 * The status guard is part of the WHERE clause so the check and the update
 * cannot race — no separate read is needed to guard the cancellation.
 * Returns the updated campaign, or null if already in a terminal state.
 */
export async function cancelCampaignIfAllowed(
  client: PoolClient,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status = 'cancelled'
     WHERE id = $1
       AND status IN (
         'draft','awaiting_confirmation','awaiting_channel','awaiting_message',
         'ready_to_send','sending','paused'
       )
     RETURNING *`,
    [id],
  )
  return rows[0] ? rowToCampaign(rows[0]) : null
}

/**
 * Atomically transition a campaign from 'sending' → 'completed' or
 * 'completed_with_errors' by computing the correct final status from the
 * actual count of failed recipients in the DB at that moment.
 *
 * The WHERE status = 'sending' guard ensures only ONE concurrent request wins
 * the finalization race. If another request already finalized the campaign,
 * this returns null — the caller should skip the audit write and trust the DB.
 */
export async function finalizeCampaign(
  client: PoolClient,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status = CASE
       WHEN (
         SELECT COUNT(*) FROM campaign_recipients
         WHERE campaign_id = $1 AND status = 'failed'
       ) > 0 THEN 'completed_with_errors'
       ELSE 'completed'
     END
     WHERE id = $1 AND status = 'sending'
     RETURNING *`,
    [id],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/** Atomic increment of sent_count or failed_count. */
export async function incrementCampaignCounters(
  client: PoolClient,
  id: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  await client.query(
    `UPDATE campaigns
     SET sent_count   = sent_count   + $2,
         failed_count = failed_count + $3
     WHERE id = $1`,
    [id, delta.sent ?? 0, delta.failed ?? 0],
  )
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** Bulk insert recipients — ignores duplicates by CNPJ per campaign. */
export async function insertCampaignRecipients(
  client: PoolClient,
  campaignId: string,
  recipients: CampaignRecipientInput[],
): Promise<void> {
  if (recipients.length === 0) return

  // Build parameterized VALUES list
  const params: unknown[] = []
  const valueRows: string[] = []

  recipients.forEach((r, i) => {
    const base = i * 8 + 1
    valueRows.push(
      `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
    )
    params.push(
      campaignId,
      r.cnpj,
      r.razao_social,
      r.nome_fantasia ?? null,
      r.telefone ?? null,
      r.email ?? null,
      r.municipio ?? null,
      r.uf ?? null,
    )
  })

  await client.query(
    `INSERT INTO campaign_recipients
       (campaign_id, cnpj, razao_social, nome_fantasia, telefone, email, municipio, uf)
     VALUES ${valueRows.join(',')}
     ON CONFLICT (campaign_id, cnpj) DO NOTHING`,
    params,
  )
}

/**
 * Atomically claim up to `limit` pending recipients for this campaign by
 * setting their status to 'processing' and stamping processing_started_at.
 *
 * Also re-claims any 'processing' rows whose lease has expired (controlled by
 * CAMPAIGN_LEASE_TIMEOUT_MINUTES env var, default 10 min), enabling automatic
 * recovery after a worker crash without manual intervention.
 *
 * Returns both the claimed recipients and a count of how many were recovered
 * from an expired lease (recoveredCount > 0 should be logged as a warning).
 */
export async function claimPendingRecipients(
  client: PoolClient,
  campaignId: string,
  limit = 100,
): Promise<{ recipients: CampaignRecipient[]; recoveredCount: number }> {
  const leaseMinutes = env.CAMPAIGN_LEASE_TIMEOUT_MINUTES
  const { rows } = await client.query(
    // The CTE captures `was_recovering` from the PRE-update state so we can
    // distinguish fresh claims (pending→processing) from lease recoveries
    // (processing→processing after expiry), without an extra round-trip.
    `WITH candidates AS (
       SELECT id,
              (status = 'processing') AS was_recovering
       FROM campaign_recipients
       WHERE campaign_id = $1
         AND (
           (
             status = 'pending'
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           )
           OR (
             status = 'processing'
             AND (processing_started_at IS NULL
                  OR processing_started_at < NOW() - ($3 * INTERVAL '1 minute'))
           )
         )
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     ),
     updated AS (
       UPDATE campaign_recipients
       SET status = 'processing',
           processing_started_at = NOW()
       WHERE id IN (SELECT id FROM candidates)
       RETURNING *
     )
     SELECT u.*, c.was_recovering
     FROM updated u
     JOIN candidates c ON c.id = u.id`,
    [campaignId, limit, leaseMinutes],
  )
  const recipients = rows.map(rowToRecipient)
  const recoveredCount = rows.filter((r) => r.was_recovering === true).length
  return { recipients, recoveredCount }
}

/** Count recipients that are still unfinished (pending or claimed but not yet done). */
export async function countPendingOrProcessingRecipients(
  client: PoolClient,
  campaignId: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS total FROM campaign_recipients
     WHERE campaign_id = $1 AND status IN ('pending', 'processing')`,
    [campaignId],
  )
  return Number(rows[0]?.total ?? 0)
}

export async function findRecipientsByCampaign(
  client: PoolClient,
  campaignId: string,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<CampaignRecipient[]> {
  const params: unknown[] = [campaignId]
  let sql = `SELECT * FROM campaign_recipients WHERE campaign_id = $1`

  if (opts.status) {
    params.push(opts.status)
    sql += ` AND status = $${params.length}`
  }

  sql += ` ORDER BY created_at ASC`

  if (opts.limit) {
    params.push(opts.limit)
    sql += ` LIMIT $${params.length}`
  }
  if (opts.offset) {
    params.push(opts.offset)
    sql += ` OFFSET $${params.length}`
  }

  const { rows } = await client.query(sql, params)
  return rows.map(rowToRecipient)
}

export async function countRecipients(
  client: PoolClient,
  campaignId: string,
  status?: string,
): Promise<number> {
  if (status) {
    const { rows } = await client.query(
      `SELECT COUNT(*) AS total FROM campaign_recipients
       WHERE campaign_id = $1 AND status = $2`,
      [campaignId, status],
    )
    return Number(rows[0]?.total ?? 0)
  }
  const { rows } = await client.query(
    `SELECT COUNT(*) AS total FROM campaign_recipients WHERE campaign_id = $1`,
    [campaignId],
  )
  return Number(rows[0]?.total ?? 0)
}

export async function updateRecipientStatus(
  client: PoolClient,
  recipientId: string,
  status: 'sent' | 'failed' | 'skipped',
  extra: {
    provider_message_id?: string | null
    error_message?: string | null
    sent_at?: Date | null
  } = {},
): Promise<void> {
  await client.query(
    `UPDATE campaign_recipients
     SET status               = $2,
         provider_message_id  = COALESCE($3, provider_message_id),
         error_message        = COALESCE($4, error_message),
         sent_at              = COALESCE($5, sent_at)
     WHERE id = $1`,
    [
      recipientId,
      status,
      extra.provider_message_id ?? null,
      extra.error_message ?? null,
      extra.sent_at ?? null,
    ],
  )
}

// ---------------------------------------------------------------------------
// Automation control
// ---------------------------------------------------------------------------

/**
 * Transition ready_to_send → sending and store the automation config.
 * Sets next_send_at = NOW() so the cron processes this campaign on the next tick.
 * Returns null if the campaign is not in 'ready_to_send' state (idempotency guard).
 */
export async function startCampaignAutomation(
  client: PoolClient,
  id: string,
  config: AutomationConfig,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status                          = 'sending',
         automation_delay_seconds        = $2,
         automation_jitter_max           = $3,
         automation_max_per_hour         = $4,
         automation_working_hours_start  = $5,
         automation_working_hours_end    = $6,
         max_retries                     = $7,
         next_send_at                    = NOW(),
         paused_at                       = NULL
     WHERE id = $1 AND status = 'ready_to_send'
     RETURNING *`,
    [
      id,
      config.delay_seconds,
      config.jitter_max,
      config.max_per_hour,
      config.working_hours_start ?? null,
      config.working_hours_end ?? null,
      config.max_retries,
    ],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/** Transition sending → paused. Records paused_at timestamp for audit. */
export async function pauseCampaign(
  client: PoolClient,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status    = 'paused',
         paused_at = NOW()
     WHERE id = $1 AND status = 'sending'
     RETURNING *`,
    [id],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/** Transition paused → sending. Resets next_send_at so the cron resumes immediately. */
export async function resumeCampaign(
  client: PoolClient,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await client.query(
    `UPDATE campaigns
     SET status       = 'sending',
         paused_at    = NULL,
         next_send_at = NOW()
     WHERE id = $1 AND status = 'paused'
     RETURNING *`,
    [id],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/** Update automation config on a running or paused campaign. */
export async function updateAutomationConfig(
  client: PoolClient,
  id: string,
  patch: UpdateAutomation,
): Promise<Campaign | null> {
  // Only update fields that were explicitly provided in the patch
  const { rows: current } = await client.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [id],
  )
  if (current.length === 0) return null

  const c = rowToCampaign(current[0])
  const { rows } = await client.query(
    `UPDATE campaigns
     SET automation_delay_seconds       = $2,
         automation_jitter_max          = $3,
         automation_max_per_hour        = $4,
         automation_working_hours_start = $5,
         automation_working_hours_end   = $6,
         max_retries                    = $7
     WHERE id = $1 AND status IN ('sending', 'paused')
     RETURNING *`,
    [
      id,
      patch.delay_seconds      ?? c.automation_delay_seconds,
      patch.jitter_max         ?? c.automation_jitter_max,
      patch.max_per_hour       ?? c.automation_max_per_hour,
      patch.working_hours_start !== undefined ? patch.working_hours_start : c.automation_working_hours_start,
      patch.working_hours_end   !== undefined ? patch.working_hours_end   : c.automation_working_hours_end,
      patch.max_retries        ?? c.max_retries,
    ],
  )
  return rows.length > 0 ? rowToCampaign(rows[0]) : null
}

/**
 * Atomically find and claim campaigns ready to process in this cron tick.
 * Uses FOR UPDATE SKIP LOCKED on the campaigns rows, then immediately advances
 * next_send_at by 5 minutes within the same transaction — preventing a second
 * concurrent cron from picking up the same campaigns.
 * The caller is responsible for COMMIT/ROLLBACK.
 */
export async function findAndClaimSendableCampaigns(
  client: PoolClient,
  limit: number,
): Promise<Campaign[]> {
  await client.query('BEGIN')
  try {
    const { rows: candidates } = await client.query(
      `SELECT * FROM campaigns
       WHERE status = 'sending'
         AND next_send_at IS NOT NULL
         AND next_send_at <= NOW()
       ORDER BY next_send_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    )
    if (candidates.length === 0) {
      await client.query('COMMIT')
      return []
    }
    const ids = candidates.map((r: Record<string, unknown>) => r.id as string)
    // Advance next_send_at so concurrent cron runs skip these campaigns
    await client.query(
      `UPDATE campaigns
       SET next_send_at = NOW() + INTERVAL '5 minutes'
       WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    await client.query('COMMIT')
    return candidates.map(rowToCampaign)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/** Update next_send_at for a campaign after a successful send. */
export async function updateCampaignNextSendAt(
  client: PoolClient,
  id: string,
  nextSendAt: Date,
): Promise<void> {
  await client.query(
    'UPDATE campaigns SET next_send_at = $2 WHERE id = $1',
    [id, nextSendAt],
  )
}

/**
 * Schedule a retry for a failed recipient with exponential backoff.
 * If the retry count has reached max_retries, marks the recipient as 'failed' permanently.
 * Returns 'failed' when the recipient hits the permanent failure state, 'retried' otherwise.
 */
export async function scheduleRecipientRetry(
  client: PoolClient,
  recipientId: string,
  currentRetryCount: number,
  maxRetries: number,
  errorMessage: string,
): Promise<'retried' | 'failed'> {
  const newRetryCount = currentRetryCount + 1
  if (newRetryCount >= maxRetries) {
    await client.query(
      `UPDATE campaign_recipients
       SET status                  = 'failed',
           error_message           = $2,
           retry_count             = $3,
           processing_started_at   = NULL
       WHERE id = $1`,
      [recipientId, `Maximo de tentativas (${maxRetries}): ${errorMessage}`, newRetryCount],
    )
    return 'failed'
  } else {
    const backoffSeconds = Math.pow(2, newRetryCount) * 30
    await client.query(
      `UPDATE campaign_recipients
       SET status                = 'pending',
           error_message         = $2,
           retry_count           = $3,
           next_retry_at         = NOW() + ($4 * INTERVAL '1 second'),
           processing_started_at = NULL
       WHERE id = $1`,
      [recipientId, errorMessage, newRetryCount, backoffSeconds],
    )
    return 'retried'
  }
}

/** Return a per-status count summary for a campaign (used by GET /status). */
export async function getCampaignProgress(
  client: PoolClient,
  campaignId: string,
): Promise<{ pending: number; processing: number; sent: number; failed: number; skipped: number }> {
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1
     GROUP BY status`,
    [campaignId],
  )
  const map: Record<string, number> = {}
  for (const r of rows) {
    // eslint-disable-next-line security/detect-object-injection
    map[r.status as string] = r.count as number
  }
  return {
    pending:    map['pending']    ?? 0,
    processing: map['processing'] ?? 0,
    sent:       map['sent']       ?? 0,
    failed:     map['failed']     ?? 0,
    skipped:    map['skipped']    ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function insertCampaignAudit(
  client: PoolClient,
  campaignId: string,
  action: string,
  performedBy: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO campaign_audit_log (campaign_id, action, performed_by, metadata)
     VALUES ($1, $2, $3, $4)`,
    [campaignId, action, performedBy, metadata ? JSON.stringify(metadata) : null],
  )
}
