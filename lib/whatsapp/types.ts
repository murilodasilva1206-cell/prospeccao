// ---------------------------------------------------------------------------
// WhatsApp channel — core types shared across adapters, repos, and routes.
// ---------------------------------------------------------------------------

export const PROVIDERS = ['META_CLOUD', 'EVOLUTION', 'UAZAPI'] as const
export type Provider = (typeof PROVIDERS)[number]

export const CHANNEL_STATUSES = [
  'DISCONNECTED',
  'PENDING_QR',
  'CONNECTING',
  'CONNECTED',
  'ERROR',
] as const
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number]

/** Row returned from the whatsapp_channels table. */
export interface Channel {
  id: string
  workspace_id: string
  name: string
  provider: Provider
  status: ChannelStatus
  phone_number: string | null
  external_instance_id: string | null
  credentials_encrypted: string  // AES-256-GCM blob — decrypt before use
  webhook_secret: string          // HMAC signing secret / provider API key
  last_seen_at: Date | null
  created_at: Date
  updated_at: Date
}

/** Decrypted credentials — never persisted in plaintext. */
export interface ChannelCredentials {
  // Meta Cloud API
  access_token?: string      // Page or System User access token
  phone_number_id?: string   // Meta phone number ID
  waba_id?: string           // WhatsApp Business Account ID
  app_secret?: string        // App secret for HMAC webhook verification

  // Evolution / UAZAPI
  instance_url?: string      // Base URL of the provider instance
  api_key?: string           // API key for the provider admin panel
}

// ---------------------------------------------------------------------------
// Message types — canonical model (provider-agnostic)
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  'text', 'image', 'audio', 'video', 'document', 'sticker', 'reaction',
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

export const MESSAGE_STATUSES = [
  'queued', 'sent', 'delivered', 'read', 'failed',
] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

/** Row from the messages table. */
export interface Message {
  id: string
  conversation_id: string
  channel_id: string
  provider_message_id: string | null
  direction: MessageDirection
  message_type: MessageType
  status: MessageStatus
  body: string | null
  media_s3_key: string | null
  media_mime_type: string | null
  media_filename: string | null
  media_size_bytes: number | null
  reaction_to_msg_id: string | null
  sent_by: string                           // 'webhook' | 'ai' | 'human:<id>'
  ai_decision_log: Record<string, unknown> | null
  raw_event: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

/** Row from the conversations table. */
export interface Conversation {
  id: string
  channel_id: string
  channel_name?: string
  channel_provider?: Provider
  workspace_id: string
  contact_phone: string
  contact_name: string | null
  status: 'open' | 'resolved' | 'ai_handled'
  last_message_at: Date | null
  unread_count: number
  ai_enabled: boolean
  created_at: Date
  updated_at: Date
}

// ---------------------------------------------------------------------------
// Media payload extracted from inbound events
// ---------------------------------------------------------------------------

export interface MediaPayload {
  from: string
  message_id: string
  message_type: MessageType
  mime_type?: string
  media_id?: string       // provider's media ID — used for downloadMedia()
  filename?: string
  caption?: string
  duration?: number       // seconds (audio/video)
  emoji?: string          // for sticker display or reaction emoji
  reaction_to?: string    // provider_message_id of the message being reacted to
}

// ---------------------------------------------------------------------------
// Normalized internal event format — provider-agnostic
// ---------------------------------------------------------------------------

export type WhatsAppEventType =
  | 'message.received'
  | 'message.sent'
  | 'message.delivered'
  | 'message.read'
  | 'connection.update'
  | 'qr.updated'
  | 'error'

export interface WhatsAppEvent {
  type: WhatsAppEventType
  channel_id: string
  provider: Provider
  /** Unique ID from the provider — used for idempotency deduplication. */
  event_id: string
  timestamp: Date
  /** Normalized payload fields relevant to the event type. */
  payload: Record<string, unknown>
}
