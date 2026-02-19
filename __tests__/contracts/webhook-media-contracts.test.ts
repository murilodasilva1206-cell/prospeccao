import { describe, it, expect } from 'vitest'
import { MetaAdapter } from '@/lib/whatsapp/adapters/meta'
import { EvolutionAdapter } from '@/lib/whatsapp/adapters/evolution'
import { UazapiAdapter } from '@/lib/whatsapp/adapters/uazapi'

import metaImageFixture from './webhook-meta-image.fixture.json'
import metaReactionFixture from './webhook-meta-reaction.fixture.json'
import evolutionAudioFixture from './webhook-evolution-audio.fixture.json'
import uazapiDocumentFixture from './webhook-uazapi-document.fixture.json'

const metaAdapter = new MetaAdapter()
const evolutionAdapter = new EvolutionAdapter()
const uazapiAdapter = new UazapiAdapter()

// ---------------------------------------------------------------------------
// Contract tests — normalize fixtures to canonical shape
// ---------------------------------------------------------------------------

describe('Webhook contract: Meta image message', () => {
  it('normalizes to message.received with image type', () => {
    const event = metaAdapter.normalizeInboundEvent(metaImageFixture)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.message_type).toBe('image')
    expect(event!.payload.from).toBe('5511999990001')
    expect(event!.payload.media_id).toBe('img-media-id-001')
    expect(event!.payload.caption).toBe('Olha esta foto!')
    expect(event!.payload.mime_type).toBe('image/jpeg')
    expect(event!.event_id).toBe('wamid.IMAGE001')
    expect(event!.timestamp).toBeInstanceOf(Date)
  })

  it('event_id is non-empty', () => {
    const event = metaAdapter.normalizeInboundEvent(metaImageFixture)
    expect(event!.event_id.length).toBeGreaterThan(0)
  })
})

describe('Webhook contract: Meta reaction message', () => {
  it('normalizes to message.received with reaction type', () => {
    const event = metaAdapter.normalizeInboundEvent(metaReactionFixture)
    expect(event).not.toBeNull()
    expect(event!.payload.message_type).toBe('reaction')
    expect(event!.payload.emoji).toBe('👍')
    expect(event!.payload.reaction_to).toBe('wamid.ORIGINAL001')
    expect(event!.payload.from).toBe('5511999990002')
  })
})

describe('Webhook contract: Evolution audio message', () => {
  it('normalizes to message.received with audio type', () => {
    const event = evolutionAdapter.normalizeInboundEvent(evolutionAudioFixture)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.message_type).toBe('audio')
    expect(event!.payload.from).toBe('5521988880001@s.whatsapp.net')
    expect(event!.payload.contact_name).toBe('Maria Silva')
    // media_id should equal the message ID (Evolution uses message key for download)
    expect(event!.payload.media_id).toBe('evo-audio-msg-001')
    expect(event!.event_id).toBe('evo-audio-msg-001')
    expect(event!.timestamp).toBeInstanceOf(Date)
    expect(event!.timestamp.getFullYear()).toBeGreaterThan(2020)
  })
})

describe('Webhook contract: UAZAPI document message', () => {
  it('normalizes to message.received with document type', () => {
    const event = uazapiAdapter.normalizeInboundEvent(uazapiDocumentFixture)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('message.received')
    expect(event!.payload.message_type).toBe('document')
    expect(event!.payload.from).toBe('5531977770001')
    expect(event!.payload.mime_type).toBe('application/pdf')
    expect(event!.payload.filename).toBe('proposta_comercial.pdf')
    expect(event!.payload.caption).toBe('Segue a proposta')
    expect(event!.payload.contact_name).toBe('Carlos Souza')
    expect(event!.event_id.length).toBeGreaterThan(0)
    expect(event!.timestamp).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// Cross-adapter shape consistency
// ---------------------------------------------------------------------------

describe('All adapters produce consistent inbound event shape', () => {
  const cases: [string, unknown, object][] = [
    ['Meta image', metaImageFixture, metaAdapter],
    ['Evolution audio', evolutionAudioFixture, evolutionAdapter],
    ['UAZAPI document', uazapiDocumentFixture, uazapiAdapter],
  ]

  it.each(cases)('%s — event has required fields', (_label, fixture, adapter) => {
    const event = (adapter as MetaAdapter).normalizeInboundEvent(fixture)
    expect(event).not.toBeNull()
    expect(typeof event!.event_id).toBe('string')
    expect(event!.event_id.length).toBeGreaterThan(0)
    expect(event!.timestamp).toBeInstanceOf(Date)
    expect(event!.type).toBe('message.received')
    expect(typeof event!.payload.from).toBe('string')
    expect(typeof event!.payload.message_type).toBe('string')
  })
})
