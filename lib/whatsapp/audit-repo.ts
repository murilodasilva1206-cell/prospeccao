// ---------------------------------------------------------------------------
// Audit log repository — append-only security event log
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'

export type AuditAction =
  | 'channel.connected'
  | 'channel.disconnected'
  | 'channel.credential_rotated'
  | 'message.sent'
  | 'media.uploaded'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'webhook.received'
  | 'ai.response'

export interface InsertAuditEventInput {
  workspace_id: string
  actor: string              // 'api_key:<label>' | 'system' | 'webhook'
  action: AuditAction
  resource_type?: string     // 'channel' | 'message' | 'api_key' | 'media'
  resource_id?: string
  meta?: Record<string, unknown>
  ip?: string
}

/**
 * Inserts an audit log entry.
 * This is append-only — no updates or deletes.
 * Errors are swallowed to avoid blocking the main request pipeline.
 */
export async function insertAuditEvent(
  client: PoolClient,
  input: InsertAuditEventInput,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor, action, resource_type, resource_id, meta, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.workspace_id,
        input.actor,
        input.action,
        input.resource_type ?? null,
        input.resource_id ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.ip ?? null,
      ],
    )
  } catch (err) {
    // Audit failures must never crash the main request
    console.error('[audit] Failed to insert audit event:', err)
  }
}
