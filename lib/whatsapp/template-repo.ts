// ---------------------------------------------------------------------------
// Template repository — all DB access for whatsapp_templates table.
// Only parameterized SQL ($N). Table populated by MetaAdapter.syncTemplates().
// ---------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import type { MetaTemplateItem, MetaTemplateComponent } from '../schemas'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhatsAppTemplate {
  id: string
  workspace_id: string
  channel_id: string
  template_name: string
  language: string
  status: string
  category: string
  components: MetaTemplateComponent[]
  variables_count: number
  is_active: boolean
  synced_at: Date
  created_at: Date
  updated_at: Date
}

export interface TemplateVariable {
  index: number
  component: 'BODY' | 'HEADER'
}

export interface SyncResult {
  created: number
  updated: number
  deactivated: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts {{N}} placeholder indices from a template text string.
 * Returns a deduplicated, sorted array of integer indices.
 */
export function extractBodyVariables(text: string): number[] {
  const matches = [...text.matchAll(/\{\{(\d+)\}\}/g)]
  const indices = [...new Set(matches.map((m) => parseInt(m[1], 10)))]
  return indices.sort((a, b) => a - b)
}

/**
 * Counts the total number of distinct {{N}} placeholders in the BODY component.
 */
function countVariables(components: MetaTemplateComponent[]): number {
  const body = components.find((c) => c.type === 'BODY')
  if (!body?.text) return 0
  return extractBodyVariables(body.text).length
}

function rowToTemplate(row: Record<string, unknown>): WhatsAppTemplate {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    channel_id: row.channel_id as string,
    template_name: row.template_name as string,
    language: row.language as string,
    status: row.status as string,
    category: row.category as string,
    components: (row.components as MetaTemplateComponent[]) ?? [],
    variables_count: row.variables_count as number,
    is_active: row.is_active as boolean,
    synced_at: new Date(row.synced_at as string),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  }
}

// ---------------------------------------------------------------------------
// upsertTemplate
// ---------------------------------------------------------------------------

/**
 * INSERT or UPDATE a single template row.
 * Uses a 2-step approach (SELECT then upsert) for reliable change classification:
 *   - no prior row  → 'created'
 *   - prior row with different status/category/components → 'updated'
 *   - identical     → 'unchanged'
 *
 * The RETURNING + xmax trick is unreliable: in an ON CONFLICT DO UPDATE,
 * EXCLUDED refers to the new values being inserted, not the old stored values,
 * so `IS DISTINCT FROM EXCLUDED.*` always compares new vs new (always equal).
 */
export async function upsertTemplate(
  client: PoolClient,
  workspaceId: string,
  channelId: string,
  tpl: MetaTemplateItem,
): Promise<'created' | 'updated' | 'unchanged'> {
  const variablesCount = countVariables(tpl.components)
  const componentsJson = JSON.stringify(tpl.components)

  // Step 1: capture the current stored state (if any)
  const { rows: existing } = await client.query<{
    status: string
    category: string
    components_text: string
  }>(
    `SELECT status, category, components::text AS components_text
       FROM whatsapp_templates
      WHERE workspace_id = $1 AND channel_id = $2 AND template_name = $3 AND language = $4`,
    [workspaceId, channelId, tpl.name, tpl.language],
  )

  // Step 2: upsert
  await client.query(
    `INSERT INTO whatsapp_templates
       (workspace_id, channel_id, template_name, language, status, category, components, variables_count, is_active, synced_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, true, NOW(), NOW())
     ON CONFLICT (workspace_id, channel_id, template_name, language)
     DO UPDATE SET
       status          = EXCLUDED.status,
       category        = EXCLUDED.category,
       components      = EXCLUDED.components,
       variables_count = EXCLUDED.variables_count,
       is_active       = true,
       synced_at       = NOW(),
       updated_at      = NOW()`,
    [workspaceId, channelId, tpl.name, tpl.language, tpl.status, tpl.category, componentsJson, variablesCount],
  )

  // Step 3: classify based on prior state
  if (existing.length === 0) return 'created'
  const prev = existing[0]
  if (
    prev.status !== tpl.status ||
    prev.category !== tpl.category ||
    prev.components_text !== componentsJson
  ) return 'updated'
  return 'unchanged'
}

// ---------------------------------------------------------------------------
// deactivateRemovedTemplates
// ---------------------------------------------------------------------------

/**
 * Sets is_active=false for all templates in the channel whose
 * (name, language) pair is NOT in the provided set.
 * Returns count of deactivated rows.
 */
export async function deactivateRemovedTemplates(
  client: PoolClient,
  workspaceId: string,
  channelId: string,
  activePairs: Array<{ name: string; language: string }>,
): Promise<number> {
  if (activePairs.length === 0) {
    // All templates removed — deactivate everything
    const { rowCount } = await client.query(
      `UPDATE whatsapp_templates
          SET is_active = false, updated_at = NOW()
        WHERE workspace_id = $1 AND channel_id = $2 AND is_active = true`,
      [workspaceId, channelId],
    )
    return rowCount ?? 0
  }

  // Build exclusion list as JSON for unnest
  const pairsJson = JSON.stringify(activePairs.map((p) => ({ name: p.name, language: p.language })))

  const { rowCount } = await client.query(
    `UPDATE whatsapp_templates
        SET is_active = false, updated_at = NOW()
      WHERE workspace_id = $1
        AND channel_id   = $2
        AND is_active    = true
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements($3::jsonb) AS pair
           WHERE pair->>'name'     = whatsapp_templates.template_name
             AND pair->>'language' = whatsapp_templates.language
        )`,
    [workspaceId, channelId, pairsJson],
  )
  return rowCount ?? 0
}

// ---------------------------------------------------------------------------
// syncTemplatesInTransaction
// ---------------------------------------------------------------------------

/**
 * High-level sync: upserts all templates and deactivates removed ones.
 * Must be called inside a transaction.
 */
export async function syncTemplatesInTransaction(
  client: PoolClient,
  workspaceId: string,
  channelId: string,
  templates: MetaTemplateItem[],
): Promise<SyncResult> {
  let created = 0
  let updated = 0

  for (const tpl of templates) {
    const action = await upsertTemplate(client, workspaceId, channelId, tpl)
    if (action === 'created') created++
    else if (action === 'updated') updated++
  }

  const activePairs = templates.map((t) => ({ name: t.name, language: t.language }))
  const deactivated = await deactivateRemovedTemplates(client, workspaceId, channelId, activePairs)

  return { created, updated, deactivated }
}

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

export interface ListTemplatesOptions {
  page: number
  limit: number
  status?: string
  language?: string
  search?: string
}

export interface ListTemplatesResult {
  data: WhatsAppTemplate[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

export async function listTemplates(
  client: PoolClient,
  workspaceId: string,
  channelId: string,
  opts: ListTemplatesOptions,
): Promise<ListTemplatesResult> {
  const conditions: string[] = [
    'workspace_id = $1',
    'channel_id = $2',
    'is_active = true',
  ]
  const values: unknown[] = [workspaceId, channelId]
  let paramIdx = 3

  if (opts.status) {
    conditions.push(`status = $${paramIdx++}`)
    values.push(opts.status)
  }
  if (opts.language) {
    conditions.push(`language = $${paramIdx++}`)
    values.push(opts.language)
  }
  if (opts.search) {
    conditions.push(`template_name ILIKE $${paramIdx++}`)
    values.push(`%${opts.search}%`)
  }

  const where = conditions.join(' AND ')
  const offset = (opts.page - 1) * opts.limit

  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM whatsapp_templates WHERE ${where}`,
    values,
  )
  const total = parseInt(countRes.rows[0].count, 10)

  const dataRes = await client.query<Record<string, unknown>>(
    `SELECT * FROM whatsapp_templates
      WHERE ${where}
      ORDER BY template_name ASC, language ASC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, opts.limit, offset],
  )

  return {
    data: dataRes.rows.map(rowToTemplate),
    pagination: {
      total,
      page: opts.page,
      limit: opts.limit,
      pages: Math.ceil(total / opts.limit),
    },
  }
}

// ---------------------------------------------------------------------------
// getTemplateById
// ---------------------------------------------------------------------------

export async function getTemplateById(
  client: PoolClient,
  id: string,
  workspaceId: string,
  channelId?: string,
): Promise<WhatsAppTemplate | null> {
  if (channelId) {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM whatsapp_templates WHERE id = $1 AND workspace_id = $2 AND channel_id = $3`,
      [id, workspaceId, channelId],
    )
    return rows.length > 0 ? rowToTemplate(rows[0]) : null
  }
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT * FROM whatsapp_templates WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  )
  return rows.length > 0 ? rowToTemplate(rows[0]) : null
}

// ---------------------------------------------------------------------------
// getTemplateVariables
// ---------------------------------------------------------------------------

/**
 * Returns {{N}} variables detected in BODY and HEADER components of the template.
 * Enforces channel_id isolation: a template from another channel returns null (→ 404).
 */
export async function getTemplateVariables(
  client: PoolClient,
  templateId: string,
  workspaceId: string,
  channelId: string,
): Promise<{ templateId: string; variables: TemplateVariable[] } | null> {
  const tpl = await getTemplateById(client, templateId, workspaceId, channelId)
  if (!tpl) return null

  const variables: TemplateVariable[] = []
  for (const comp of tpl.components) {
    if ((comp.type === 'BODY' || comp.type === 'HEADER') && comp.text) {
      const indices = extractBodyVariables(comp.text)
      for (const index of indices) {
        variables.push({ index, component: comp.type })
      }
    }
  }

  return { templateId, variables }
}
