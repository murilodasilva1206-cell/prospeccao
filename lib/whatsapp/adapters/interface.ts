// ---------------------------------------------------------------------------
// IWhatsAppAdapter - contract every provider adapter must implement.
//
// Each method receives the full Channel and decrypted ChannelCredentials so
// adapters do not need to decrypt themselves.
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

export interface DownloadResult {
  buffer: Buffer
  mime: string
  filename: string
}

export interface IWhatsAppAdapter {
  createChannel(
    channel: Channel,
    creds: ChannelCredentials,
  ): Promise<{ external_instance_id: string }>

  startConnection(channel: Channel, creds: ChannelCredentials): Promise<ConnectResult>

  getConnectionStatus(channel: Channel, creds: ChannelCredentials): Promise<ChannelStatus>

  disconnect(channel: Channel, creds: ChannelCredentials): Promise<void>

  /** Sends a plain text message. */
  sendMessage(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    text: string,
  ): Promise<SendResult>

  /** Sends a media message (image, video, document). */
  sendMedia(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    mediaBuffer: Buffer,
    mime: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult>

  /** Sends an audio/PTT message. */
  sendAudio(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    audioBuffer: Buffer,
  ): Promise<SendResult>

  /** Sends a sticker (WebP). */
  sendSticker(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    stickerBuffer: Buffer,
  ): Promise<SendResult>

  /** Sends a reaction emoji to an existing message. */
  sendReaction(
    channel: Channel,
    creds: ChannelCredentials,
    to: string,
    emoji: string,
    targetMessageId: string,
  ): Promise<SendResult>

  /**
   * Downloads media referenced in an inbound event.
   * Use the media_id from the normalized inbound event payload.
   */
  downloadMedia(
    channel: Channel,
    creds: ChannelCredentials,
    mediaId: string,
  ): Promise<DownloadResult>

  /**
   * Normalizes an inbound message event (all types: text, image, audio, etc.).
   * Returns null if the payload does not represent an inbound message.
   */
  normalizeInboundEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null

  /**
   * Normalizes a status update event (sent/delivered/read) for outbound messages.
   * Returns null if the payload does not represent a status update.
   */
  normalizeStatusEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'> | null

  /**
   * Verifies the incoming webhook request signature.
   * Returns false on any mismatch - caller must respond 401.
   */
  verifyWebhookSignature(
    channel: Channel,
    creds: ChannelCredentials,
    headers: Headers,
    rawBody: string,
  ): boolean

  /**
   * @deprecated Use normalizeInboundEvent / normalizeStatusEvent instead.
   * Kept for backward compatibility with processWebhook pipeline.
   */
  normalizeEvent(
    rawPayload: unknown,
  ): Omit<WhatsAppEvent, 'channel_id' | 'provider'>
}
