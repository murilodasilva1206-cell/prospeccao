import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

// Trim, collapse multiple spaces, enforce max length.
const SafeString = (maxLen: number) =>
  z
    .string()
    .trim()
    .max(maxLen, `Max ${maxLen} characters`)
    .transform((s) => s.replace(/\s+/g, ' '))

// Pagination — coerce because query params are always strings
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20), // hard cap at 100 rows
})

// Boolean from query string — z.coerce.boolean() converts any non-empty string to true
// (because JS Boolean('false') === true). We need explicit string-to-boolean mapping.
const QueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional()

// ---------------------------------------------------------------------------
// /api/busca — search empresas (CNPJ registry)
// ---------------------------------------------------------------------------
export const BuscaQuerySchema = PaginationSchema.extend({
  // Localização
  uf: z.string().length(2).toUpperCase().optional(),          // e.g. SP, RJ, MG
  municipio: SafeString(150).optional(),                       // e.g. "São Paulo"

  // Atividade econômica
  cnae_principal: SafeString(20).optional(),                   // e.g. "8630-5/04"
  nicho: SafeString(100).optional(),                           // texto livre → mapeado para CNAE

  // Status cadastral (Receita Federal)
  situacao_cadastral: z
    .enum(['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA'])
    .default('ATIVA'),

  // Filtros de contato disponível
  tem_telefone: QueryBoolean,
  tem_email: QueryBoolean,

  // Whitelist — prevents ORDER BY injection via arbitrary column names
  orderBy: z
    .enum(['razao_social', 'municipio', 'cnpj_completo'])
    .default('razao_social'),
  orderDir: z.enum(['asc', 'desc']).default('asc'),
})

export type BuscaQuery = z.infer<typeof BuscaQuerySchema>

// ---------------------------------------------------------------------------
// /api/agente — AI agent chat
// ---------------------------------------------------------------------------
export const AgenteBodySchema = z.object({
  message: SafeString(1000), // cap at 1000 chars to limit token cost and injection surface
})

export type AgenteBody = z.infer<typeof AgenteBodySchema>

// ---------------------------------------------------------------------------
// /api/export — CSV download
// ---------------------------------------------------------------------------
export const ExportQuerySchema = z.object({
  formato: z.enum(['csv']).default('csv'),
  uf: z.string().length(2).toUpperCase().optional(),
  municipio: SafeString(150).optional(),
  cnae_principal: SafeString(20).optional(),
  nicho: SafeString(100).optional(),
  situacao_cadastral: z
    .enum(['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA'])
    .default('ATIVA'),
  tem_telefone: QueryBoolean,
  tem_email: QueryBoolean,
  orderBy: z
    .enum(['razao_social', 'municipio', 'cnpj_completo'])
    .default('razao_social'),
  orderDir: z.enum(['asc', 'desc']).default('asc'),
  // Hard cap: never export more than 5000 rows in a single request
  maxRows: z.coerce.number().int().min(1).max(5000).default(1000),
})

export type ExportQuery = z.infer<typeof ExportQuerySchema>

// ---------------------------------------------------------------------------
// AI response contract — validate before using any field from the AI
// ---------------------------------------------------------------------------
export const AgentIntentSchema = z.object({
  action: z.enum(['search', 'export', 'clarify', 'reject']),
  filters: BuscaQuerySchema.partial().optional(),
  confidence: z.number().min(0).max(1),
  message: SafeString(500).optional(), // only for clarify/reject actions
})

export type AgentIntent = z.infer<typeof AgentIntentSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp — channel management
// ---------------------------------------------------------------------------

export const WHATSAPP_PROVIDERS = ['META_CLOUD', 'EVOLUTION', 'UAZAPI'] as const
export type WhatsAppProvider = (typeof WHATSAPP_PROVIDERS)[number]

// Credentials shape — at schema level all are optional; adapters validate per-provider
const ChannelCredentialsSchema = z.object({
  access_token: SafeString(512).optional(),    // Meta: page/system access token
  phone_number_id: SafeString(50).optional(),  // Meta: phone number ID
  waba_id: SafeString(50).optional(),          // Meta: WhatsApp Business Account ID
  app_secret: SafeString(200).optional(),      // Meta: app secret for HMAC verification
  instance_url: SafeString(512).optional(),    // Evolution/UAZAPI: base instance URL
  api_key: SafeString(200).optional(),         // Evolution/UAZAPI: API key
})

export const ChannelCreateSchema = z.object({
  // workspace_id is ignored in the route — the authoritative value always comes from
  // the Bearer token (auth.workspace_id). Kept optional for backward-compat with existing clients.
  workspace_id: SafeString(100).optional(),
  name: SafeString(100),
  provider: z.enum(WHATSAPP_PROVIDERS),
  credentials: ChannelCredentialsSchema,
  // phone_number is optional at creation; set after successful connection
  phone_number: z.string().regex(/^\+?\d{8,15}$/).optional(),
})
export type ChannelCreate = z.infer<typeof ChannelCreateSchema>
export type ChannelCredentialsInput = z.infer<typeof ChannelCredentialsSchema>

export const SendMessageSchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'Numero deve conter apenas digitos (8-15)'),
  message: z.string().min(1).max(4096),
})
export type SendMessage = z.infer<typeof SendMessageSchema>

// Validates dynamic route params for /api/whatsapp/webhook/[provider]/[channelId]
export const WebhookPathSchema = z.object({
  provider: z.enum(WHATSAPP_PROVIDERS),
  channelId: z.string().uuid('channelId deve ser um UUID valido'),
})

// ---------------------------------------------------------------------------
// /api/whatsapp/keys — workspace API key management
// ---------------------------------------------------------------------------

export const ApiKeyCreateSchema = z.object({
  // workspace_id is ignored in the route — the authoritative value always comes from
  // the Bearer token (auth.workspace_id). Kept optional for backward-compat with existing clients.
  workspace_id: SafeString(100).optional(),
  label: SafeString(100),
  created_by: SafeString(200).optional(),
})
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp/channels/:id/send-media — media message sending
// ---------------------------------------------------------------------------

export const MEDIA_MESSAGE_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const
export type MediaMessageType = (typeof MEDIA_MESSAGE_TYPES)[number]

export const SendMediaSchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'Numero deve conter apenas digitos (8-15)'),
  type: z.enum(MEDIA_MESSAGE_TYPES),
  caption: z.string().max(1024).optional(),
})
export type SendMedia = z.infer<typeof SendMediaSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp/channels/:id/send-reaction — reaction messages
// ---------------------------------------------------------------------------

export const SendReactionSchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'Numero deve conter apenas digitos (8-15)'),
  emoji: z.string().min(1).max(8),
  // Provider message IDs are NOT UUIDs — Meta uses wamid.xxx, Evolution uses arbitrary strings.
  target_provider_message_id: z.string().min(8).max(200),
})
export type SendReaction = z.infer<typeof SendReactionSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp/channels/:id/send-template — Meta template messages
// ---------------------------------------------------------------------------

export const SendTemplateSchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'Numero deve conter apenas digitos (8-15)'),
  name: SafeString(120),
  language: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})$/, 'Idioma invalido (ex: pt_BR)'),
  body_params: z.array(SafeString(250)).max(10).optional().default([]),
})
export type SendTemplate = z.infer<typeof SendTemplateSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp/conversations — conversation management
// ---------------------------------------------------------------------------

export const ConversationPatchSchema = z.object({
  status: z.enum(['open', 'resolved', 'ai_handled']).optional(),
  ai_enabled: z.boolean().optional(),
})
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>

// ---------------------------------------------------------------------------
// /api/whatsapp/conversations/:id/messages — message pagination
// ---------------------------------------------------------------------------

export const MessagePaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().uuid().optional(), // cursor: fetch messages older than this message ID
})
export type MessagePagination = z.infer<typeof MessagePaginationSchema>

// ---------------------------------------------------------------------------
// AI inbox agent response contract
// ---------------------------------------------------------------------------

export const InboxAiResponseSchema = z.object({
  action: z.enum(['reply', 'escalate', 'ignore']),
  reply_text: z.string().max(4096).optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).optional(),
})
export type InboxAiResponse = z.infer<typeof InboxAiResponseSchema>

// ---------------------------------------------------------------------------
// /api/campaigns — blast campaign state machine
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = [
  'draft',
  'awaiting_confirmation',
  'awaiting_channel',
  'awaiting_message',
  'ready_to_send',
  'sending',
  'completed',
  'completed_with_errors',
  'cancelled',
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

/** Single lead in a campaign recipient list */
export const CampaignRecipientInputSchema = z.object({
  cnpj: SafeString(20),
  razao_social: SafeString(200),
  nome_fantasia: SafeString(200).optional(),
  telefone: SafeString(20).optional(),
  email: SafeString(200).optional(),
  municipio: SafeString(150).optional(),
  uf: z.string().length(2).toUpperCase().optional(),
})
export type CampaignRecipientInput = z.infer<typeof CampaignRecipientInputSchema>

/** POST /api/campaigns — create a draft campaign from agent search results */
export const CreateCampaignSchema = z.object({
  name: SafeString(200).optional(),
  search_filters: z.record(z.string(), z.unknown()).optional(),
  recipients: z.array(CampaignRecipientInputSchema).min(1).max(500),
})
export type CreateCampaign = z.infer<typeof CreateCampaignSchema>

/** POST /api/campaigns/:id/confirm — user echoes confirmation_token */
export const ConfirmCampaignSchema = z.object({
  confirmation_token: z.string().min(32).max(128),
})
export type ConfirmCampaign = z.infer<typeof ConfirmCampaignSchema>

/** POST /api/campaigns/:id/select-channel */
export const SelectChannelSchema = z.object({
  channel_id: z.string().uuid('channel_id deve ser um UUID valido'),
})
export type SelectChannel = z.infer<typeof SelectChannelSchema>

/** Message content shape for template messages (Meta only) */
const TemplateMessageContentSchema = z.object({
  type: z.literal('template'),
  name: SafeString(120),
  language: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})$/, 'Idioma invalido (ex: pt_BR)'),
  body_params: z.array(SafeString(250)).max(10).optional().default([]),
})

/** Message content shape for plain text messages (non-Meta) */
const TextMessageContentSchema = z.object({
  type: z.literal('text'),
  body: SafeString(4096),
})

/** POST /api/campaigns/:id/set-message */
export const SetCampaignMessageSchema = z
  .object({
    message_type: z.enum(['template', 'text']),
    message_content: z.discriminatedUnion('type', [
      TemplateMessageContentSchema,
      TextMessageContentSchema,
    ]),
  })
  .superRefine((val, ctx) => {
    if (val.message_type !== val.message_content.type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `message_type '${val.message_type}' deve corresponder a message_content.type '${val.message_content.type}'`,
        path: ['message_type'],
      })
    }
  })
export type SetCampaignMessage = z.infer<typeof SetCampaignMessageSchema>

/** GET /api/campaigns/:id/recipients pagination */
export const RecipientPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'processing', 'sent', 'failed', 'skipped']).optional(),
})
