// Unit tests for handleStatusUpdate in lib/whatsapp/webhook-handler.ts.
//
// All DB interactions are mocked so these tests run without a live PostgreSQL.
// Covered scenarios:
//   1. message.failed → message status 'failed' + campaign reconciliation
//   2. message.delivered → message status 'delivered' + delivered_at stamped on recipient
//   3. message.read → message status 'read' + delivered_at stamped on recipient
//   4. message.sent → message status 'sent', no campaign touch
//   5. Missing provider_message_id → returns false without DB calls
//   6. Unrecognized event type → returns false without DB calls

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

const mockUpdateMessageStatus = vi.fn()
const mockUpdateRecipientStatusByProviderMessageId = vi.fn()
const mockMarkRecipientDeliveredByProviderMessageId = vi.fn()

vi.mock('@/lib/whatsapp/message-repo', () => ({
  updateMessageStatus: (...args: unknown[]) => mockUpdateMessageStatus(...args),
}))

vi.mock('@/lib/campaign-repo', () => ({
  updateRecipientStatusByProviderMessageId: (...args: unknown[]) =>
    mockUpdateRecipientStatusByProviderMessageId(...args),
  markRecipientDeliveredByProviderMessageId: (...args: unknown[]) =>
    mockMarkRecipientDeliveredByProviderMessageId(...args),
}))

import { handleStatusUpdate } from '@/lib/whatsapp/webhook-handler'
import type { WhatsAppEvent } from '@/lib/whatsapp/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: WhatsAppEvent['type'], messageId: string | null, errorReason?: string): WhatsAppEvent {
  return {
    type,
    channel_id: 'ch-001',
    provider: 'META_CLOUD',
    event_id: `${messageId}-${type}`,
    timestamp: new Date(),
    payload: {
      message_id: messageId ?? undefined,
      status: type.replace('message.', ''),
      ...(errorReason ? { error_reason: errorReason } : {}),
    },
  }
}

const fakeClient = {} as PoolClient

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateMessageStatus.mockResolvedValue(true)
  mockUpdateRecipientStatusByProviderMessageId.mockResolvedValue(true)
  mockMarkRecipientDeliveredByProviderMessageId.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------
// message.failed
// ---------------------------------------------------------------------------
describe('handleStatusUpdate — message.failed', () => {
  it('marks message as failed and reconciles campaign recipient', async () => {
    const event = makeEvent('message.failed', 'wamid.fail001', 'Message Undeliverable')
    const result = await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(result).toBe(true)
    expect(mockUpdateMessageStatus).toHaveBeenCalledWith(fakeClient, {
      channel_id: 'ch-001',
      provider_message_id: 'wamid.fail001',
      status: 'failed',
    })
    expect(mockUpdateRecipientStatusByProviderMessageId).toHaveBeenCalledWith(
      fakeClient,
      'ch-001',
      'wamid.fail001',
      'failed',
      'Message Undeliverable',
    )
    expect(mockMarkRecipientDeliveredByProviderMessageId).not.toHaveBeenCalled()
  })

  it('uses default error reason when error_reason is absent', async () => {
    const event = makeEvent('message.failed', 'wamid.fail002')
    await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    const [, , , , reason] = mockUpdateRecipientStatusByProviderMessageId.mock.calls[0]
    expect(typeof reason).toBe('string')
    expect(reason.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// message.delivered
// ---------------------------------------------------------------------------
describe('handleStatusUpdate — message.delivered', () => {
  it('marks message as delivered and stamps delivered_at on recipient', async () => {
    const event = makeEvent('message.delivered', 'wamid.del001')
    const result = await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(result).toBe(true)
    expect(mockUpdateMessageStatus).toHaveBeenCalledWith(fakeClient, {
      channel_id: 'ch-001',
      provider_message_id: 'wamid.del001',
      status: 'delivered',
    })
    // Must NOT move recipient to failed
    expect(mockUpdateRecipientStatusByProviderMessageId).not.toHaveBeenCalled()
    // Must stamp delivered_at to prevent watchdog timeout
    expect(mockMarkRecipientDeliveredByProviderMessageId).toHaveBeenCalledWith(
      fakeClient,
      'ch-001',
      'wamid.del001',
    )
  })
})

// ---------------------------------------------------------------------------
// message.read
// ---------------------------------------------------------------------------
describe('handleStatusUpdate — message.read', () => {
  it('marks message as read and stamps delivered_at on recipient', async () => {
    const event = makeEvent('message.read', 'wamid.read001')
    await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(mockUpdateMessageStatus).toHaveBeenCalledWith(fakeClient, expect.objectContaining({
      status: 'read',
    }))
    expect(mockUpdateRecipientStatusByProviderMessageId).not.toHaveBeenCalled()
    // read also stamps delivered_at (treats read as confirmed delivery)
    expect(mockMarkRecipientDeliveredByProviderMessageId).toHaveBeenCalledWith(
      fakeClient,
      'ch-001',
      'wamid.read001',
    )
  })
})

// ---------------------------------------------------------------------------
// message.sent
// ---------------------------------------------------------------------------
describe('handleStatusUpdate — message.sent', () => {
  it('marks message as sent without touching campaign recipient', async () => {
    const event = makeEvent('message.sent', 'wamid.sent001')
    await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(mockUpdateMessageStatus).toHaveBeenCalledWith(fakeClient, expect.objectContaining({
      status: 'sent',
    }))
    expect(mockUpdateRecipientStatusByProviderMessageId).not.toHaveBeenCalled()
    expect(mockMarkRecipientDeliveredByProviderMessageId).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('handleStatusUpdate — edge cases', () => {
  it('returns false when provider_message_id is null', async () => {
    const event = makeEvent('message.failed', null)
    const result = await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(result).toBe(false)
    expect(mockUpdateMessageStatus).not.toHaveBeenCalled()
    expect(mockUpdateRecipientStatusByProviderMessageId).not.toHaveBeenCalled()
    expect(mockMarkRecipientDeliveredByProviderMessageId).not.toHaveBeenCalled()
  })

  it('returns false for unrecognized event type', async () => {
    const event: WhatsAppEvent = {
      type: 'connection.update',
      channel_id: 'ch-001',
      provider: 'META_CLOUD',
      event_id: 'conn-1',
      timestamp: new Date(),
      payload: { message_id: 'wamid.x' },
    }
    const result = await handleStatusUpdate(fakeClient, event, { id: 'ch-001' })

    expect(result).toBe(false)
    expect(mockUpdateMessageStatus).not.toHaveBeenCalled()
  })
})
