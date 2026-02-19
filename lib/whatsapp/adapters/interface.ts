// ---------------------------------------------------------------------------
// IWhatsAppAdapter — contract every provider adapter must implement.
//
// Each method receives the full Channel and decrypted ChannelCredentials so
// adapters don't need to decrypt themselves.
// ---------------------------------------------------------------------------

import type { Channel, ChannelCredentials, ChannelStatus, WhatsAppEvent } from '../types'

export interface ConnectResult {
  /** Status immediately after attempting connection. */
  status: ChannelStatus
  /** Base64 QR code string (Evolution / UAZAPI only). */
  qr_code?: string
  /** Phone number registered on the provider (Meta sets this at connect time). */
  phone_number?: string
  /** Provider-assigned instance / phone number ID. */
  external_instance_id?: string
}

export interface SendResult {
  /** Provider-assigned outbound message ID. */
  message_id: string
}

export interface IWhatsAppAdapter {
  /**
   * Validates credentials and registers the channel on the provider side.
   * Returns the provider-assigned external_instance_id.
   */
  createChannel(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }>

  /**
   * Initiates the connection flow.
   * - Meta: validates token → CONNECTED immediately.
   * - Evolution/UAZAPI: creates instance → returns QR → PENDING_QR.
   */
  startConnection(channel: Channel, creds: ChannelCredentials): Promise<ConnectResult>

  /** Polls the provider for the current connection state. */
  getConnectionStatus(channel: Channel, creds: ChannelCredentials): Promise<ChannelStatus>

  /** Logs out and frees the channel on the provider side. */
  disconnect(channel: Channel, creds: ChannelCredentials): Promise<void>

  /** Sends a text message. */
  sendMessage(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult>

  /**
   * Verifies the incoming webhook request signature.
   * - Meta: HMAC-SHA256(rawBody, app_secret) vs X-Hub-Signature-256 header.
   * - Evolution/UAZAPI: constant-time compare header apikey vs channel.webhook_secret.
   * Returns false on any mismatch — caller must respond 401.
   */
  verifyWebhookSignature(
    channel: Channel,
    creds: ChannelCredentials,
    headers: Headers,
    rawBody: string,
  ): boolean

  /**
   * Converts a raw provider webhook payload to a normalized WhatsAppEvent.
   * channel_id and provider are filled in by the webhook handler.
   */
  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'>
}
