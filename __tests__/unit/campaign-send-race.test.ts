// ---------------------------------------------------------------------------
// Unit test: /api/campaigns/:id/send — finalization race condition response
//
// Verifies the bug fix: when finalizeCampaign() returns null (another request
// already won the race), the route must re-read the campaign from the DB and
// return the *real* status rather than blindly returning 'completed'.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks — declared before the route import so Vitest hoists them correctly
// ---------------------------------------------------------------------------

// vi.hoisted ensures these values exist when vi.mock factories run (which are
// hoisted to the top of the file by Vitest's transform).
const { mockRelease, mockClient } = vi.hoisted(() => {
  const mockRelease = vi.fn()
  const mockClient = { release: mockRelease }
  return { mockRelease, mockClient }
})

vi.mock('@/lib/database', () => ({
  default: { connect: vi.fn().mockResolvedValue(mockClient) },
}))

vi.mock('@/lib/rate-limit', () => ({
  campaignSendLimiter: {
    check: vi.fn().mockResolvedValue({ success: true, remaining: 9, resetAt: Date.now() + 60_000 }),
  },
}))

vi.mock('@/lib/get-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

vi.mock('@/lib/whatsapp/auth-middleware', () => ({
  requireWorkspaceAuth: vi.fn().mockResolvedValue({
    workspace_id: 'ws-test',
    key_id: 'key-test',
    actor: 'test',
  }),
  authErrorResponse: vi.fn().mockReturnValue(null),
}))

const mockFindCampaignById = vi.fn()
const mockClaimPendingRecipients = vi.fn()
const mockCountPendingOrProcessingRecipients = vi.fn()
const mockFinalizeCampaign = vi.fn()
const mockInsertCampaignAudit = vi.fn()
const mockUpdateCampaignStatus = vi.fn()
const mockUpdateRecipientStatus = vi.fn()
const mockIncrementCampaignCounters = vi.fn()

vi.mock('@/lib/campaign-repo', () => ({
  findCampaignById: (...args: unknown[]) => mockFindCampaignById(...args),
  claimPendingRecipients: (...args: unknown[]) => mockClaimPendingRecipients(...args),
  countPendingOrProcessingRecipients: (...args: unknown[]) => mockCountPendingOrProcessingRecipients(...args),
  finalizeCampaign: (...args: unknown[]) => mockFinalizeCampaign(...args),
  insertCampaignAudit: (...args: unknown[]) => mockInsertCampaignAudit(...args),
  updateCampaignStatus: (...args: unknown[]) => mockUpdateCampaignStatus(...args),
  updateRecipientStatus: (...args: unknown[]) => mockUpdateRecipientStatus(...args),
  incrementCampaignCounters: (...args: unknown[]) => mockIncrementCampaignCounters(...args),
}))

vi.mock('@/lib/whatsapp/channel-repo', () => ({
  findChannelById: vi.fn().mockResolvedValue({
    id: 'ch-1',
    workspace_id: 'ws-test',
    provider: 'UAZAPI',
    status: 'CONNECTED',
    credentials_encrypted: 'enc-creds',
  }),
}))

vi.mock('@/lib/whatsapp/crypto', () => ({
  decryptCredentials: vi.fn().mockReturnValue({ token: 'test-token', instance: 'inst' }),
}))

vi.mock('@/lib/whatsapp/adapters/factory', () => ({
  getAdapter: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 'msg-1' }),
    sendTemplate: vi.fn().mockResolvedValue({ message_id: 'msg-1' }),
  }),
}))

vi.mock('@/lib/whatsapp/conversation-repo', () => ({
  upsertConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
}))

vi.mock('@/lib/whatsapp/message-repo', () => ({
  insertMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/agent-humanizer', () => ({
  normalizePhoneForWhatsApp: vi.fn().mockReturnValue('+5511999990000'),
  applyMessageTemplate: vi.fn().mockImplementation((body: string) => body),
}))

// Import route AFTER all mocks are in place
import { POST } from '@/app/api/campaigns/[id]/send/route'

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

// Must be a RFC 4122 compliant UUID — Zod validates version (1-8) and variant bits ([89abAB])
const CAMPAIGN_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

function makeSendRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/campaigns/${CAMPAIGN_ID}/send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wk_test' },
  })
}

function makeParams() {
  return { params: Promise.resolve({ id: CAMPAIGN_ID }) }
}

/** A campaign in 'ready_to_send' with channel + message configured.
 *  The route transitions it to 'sending' internally via updateCampaignStatus. */
const sendingCampaign = {
  id: CAMPAIGN_ID,
  workspace_id: 'ws-test',
  status: 'ready_to_send',
  channel_id: 'ch-1',
  message_type: 'text',
  message_content: { body: 'Ola [Nome]!' },
  total_count: 2,
  sent_count: 1,
  failed_count: 1,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/campaigns/:id/send — finalization race condition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRelease.mockReturnValue(undefined)
  })

  it('returns status=completed_with_errors when finalizeCampaign loses the race and DB shows completed_with_errors', async () => {
    // Arrange
    // 1st call: initial campaign load (status=sending, valid channel+message)
    // 2nd call: re-read after losing finalization race (status=completed_with_errors)
    mockFindCampaignById
      .mockResolvedValueOnce(sendingCampaign)
      .mockResolvedValueOnce({ ...sendingCampaign, status: 'completed_with_errors' })

    // No pending recipients in this batch — batch is empty (someone else processed them)
    mockClaimPendingRecipients.mockResolvedValue({ recipients: [], recoveredCount: 0 })

    // Zero remaining — all recipients are terminal
    mockCountPendingOrProcessingRecipients.mockResolvedValue(0)

    // Lost the finalization race — another request already finalized
    mockFinalizeCampaign.mockResolvedValue(null)

    mockInsertCampaignAudit.mockResolvedValue(undefined)

    // Act
    const res = await POST(makeSendRequest(), makeParams())
    const body = await res.json()

    // Assert
    expect(res.status).toBe(200)
    expect(body.data.status).toBe('completed_with_errors')
    expect(body.data.completed).toBe(true)
    expect(body.data.campaign_id).toBe(CAMPAIGN_ID)

    // finalizeCampaign must have been called (the race attempt)
    expect(mockFinalizeCampaign).toHaveBeenCalledOnce()

    // findCampaignById must have been called twice:
    // once for auth check, once for the race-loss re-read
    expect(mockFindCampaignById).toHaveBeenCalledTimes(2)

    // 'sending_started' audit is written when transitioning ready_to_send → sending,
    // but the race LOSER must NOT write a 'completed' audit entry.
    expect(mockInsertCampaignAudit).toHaveBeenCalledTimes(1)
    expect(mockInsertCampaignAudit).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN_ID, 'sending_started', 'key-test', expect.any(Object),
    )
  })

  it('returns status=completed when finalizeCampaign loses the race and DB shows completed', async () => {
    mockFindCampaignById
      .mockResolvedValueOnce(sendingCampaign)
      .mockResolvedValueOnce({ ...sendingCampaign, status: 'completed' })

    mockClaimPendingRecipients.mockResolvedValue({ recipients: [], recoveredCount: 0 })
    mockCountPendingOrProcessingRecipients.mockResolvedValue(0)
    mockFinalizeCampaign.mockResolvedValue(null)
    mockInsertCampaignAudit.mockResolvedValue(undefined)

    const res = await POST(makeSendRequest(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('completed')
    expect(body.data.completed).toBe(true)
  })

  it('returns status=sending when finalizeCampaign loses the race but DB still shows sending', async () => {
    // Edge case: race lost but status is still 'sending' (another request is mid-flight)
    mockFindCampaignById
      .mockResolvedValueOnce(sendingCampaign)
      .mockResolvedValueOnce({ ...sendingCampaign, status: 'sending' })

    mockClaimPendingRecipients.mockResolvedValue({ recipients: [], recoveredCount: 0 })
    mockCountPendingOrProcessingRecipients.mockResolvedValue(0)
    mockFinalizeCampaign.mockResolvedValue(null)

    const res = await POST(makeSendRequest(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('sending')
    expect(body.data.completed).toBe(false)
  })

  it('returns status=completed_with_errors and writes audit when this request wins the race', async () => {
    const finalizedCampaign = { ...sendingCampaign, status: 'completed_with_errors', sent_count: 1, failed_count: 1 }

    mockFindCampaignById.mockResolvedValueOnce(sendingCampaign)
    mockClaimPendingRecipients.mockResolvedValue({ recipients: [], recoveredCount: 0 })
    mockCountPendingOrProcessingRecipients.mockResolvedValue(0)
    // This request wins the race
    mockFinalizeCampaign.mockResolvedValue(finalizedCampaign)
    mockInsertCampaignAudit.mockResolvedValue(undefined)

    const res = await POST(makeSendRequest(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('completed_with_errors')
    expect(body.data.completed).toBe(true)

    // Winner writes two audit entries: 'sending_started' + 'completed'
    expect(mockInsertCampaignAudit).toHaveBeenCalledTimes(2)
    expect(mockInsertCampaignAudit).toHaveBeenCalledWith(
      mockClient,
      CAMPAIGN_ID,
      'completed',
      'key-test',
      expect.objectContaining({ status: 'completed_with_errors' }),
    )

    // findCampaignById called only once (no race-loss re-read needed)
    expect(mockFindCampaignById).toHaveBeenCalledTimes(1)
  })
})
