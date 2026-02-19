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
