import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateMediaFile, sanitizeFilename, ALLOWED_MIMES } from '@/lib/whatsapp/media'

// ---------------------------------------------------------------------------
// validateMediaFile
// ---------------------------------------------------------------------------

// Helper: create a buffer with specific magic bytes at offset
function makeBuffer(magic: number[], totalSize = 100): Buffer {
  const buf = Buffer.alloc(totalSize, 0x00)
  magic.forEach((b, i) => { buf[i] = b })
  return buf
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const PNG_MAGIC  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PDF_MAGIC  = [0x25, 0x50, 0x44, 0x46]  // %PDF
const OGG_MAGIC  = [0x4f, 0x67, 0x67, 0x53]  // OggS

describe('validateMediaFile', () => {
  it('accepts a valid JPEG', () => {
    const buf = makeBuffer(JPEG_MAGIC)
    const result = validateMediaFile(buf, 'image/jpeg')
    expect(result.mime).toBe('image/jpeg')
    expect(result.ext).toBe('jpg')
    expect(result.category).toBe('image')
  })

  it('accepts a valid PNG', () => {
    const buf = makeBuffer(PNG_MAGIC)
    const result = validateMediaFile(buf, 'image/png')
    expect(result.mime).toBe('image/png')
  })

  it('accepts a valid PDF', () => {
    const buf = makeBuffer(PDF_MAGIC)
    const result = validateMediaFile(buf, 'application/pdf')
    expect(result.ext).toBe('pdf')
    expect(result.category).toBe('document')
  })

  it('accepts a valid OGG audio', () => {
    const buf = makeBuffer(OGG_MAGIC)
    const result = validateMediaFile(buf, 'audio/ogg')
    expect(result.category).toBe('audio')
  })

  it('rejects an empty buffer', () => {
    expect(() => validateMediaFile(Buffer.alloc(0), 'image/jpeg')).toThrow('Empty file')
  })

  it('rejects a MIME type not in allowlist', () => {
    const buf = makeBuffer(JPEG_MAGIC)
    expect(() => validateMediaFile(buf, 'image/svg+xml')).toThrow('not allowed')
  })

  it('rejects application/x-executable', () => {
    const buf = makeBuffer([0x4d, 0x5a]) // MZ header = PE/EXE
    expect(() => validateMediaFile(buf, 'application/x-executable')).toThrow('not allowed')
  })

  it('rejects oversized image (> 5 MB)', () => {
    const bigBuf = makeBuffer(JPEG_MAGIC, 6 * 1024 * 1024)
    expect(() => validateMediaFile(bigBuf, 'image/jpeg')).toThrow('too large')
  })

  it('rejects JPEG content with PNG MIME (magic bytes mismatch)', () => {
    const jpegContent = makeBuffer(JPEG_MAGIC)
    expect(() => validateMediaFile(jpegContent, 'image/png')).toThrow('does not match')
  })

  it('rejects JPEG MIME with PNG content (magic bytes mismatch)', () => {
    const pngContent = makeBuffer(PNG_MAGIC)
    expect(() => validateMediaFile(pngContent, 'image/jpeg')).toThrow('does not match')
  })

  it('passes through types without magic byte rules (e.g. text/plain)', () => {
    const buf = Buffer.from('hello world')
    const result = validateMediaFile(buf, 'text/plain')
    expect(result.ext).toBe('txt')
  })

  it('normalizes MIME with charset suffix', () => {
    const buf = Buffer.from('hello world')
    const result = validateMediaFile(buf, 'text/plain; charset=utf-8')
    expect(result.mime).toBe('text/plain')
  })
})

// ---------------------------------------------------------------------------
// sanitizeFilename
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  it('removes path separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/')
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..')
  })

  it('limits to 255 characters', () => {
    const long = 'a'.repeat(300) + '.jpg'
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(255)
  })

  it('falls back to "upload" for empty result', () => {
    expect(sanitizeFilename('   ')).toBe('upload')
  })

  it('replaces special characters with underscore', () => {
    const result = sanitizeFilename('my file<>?.jpg')
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
    expect(result).not.toContain('?')
  })

  it('preserves safe characters', () => {
    const result = sanitizeFilename('my-file_v2.1.jpg')
    expect(result).toBe('my-file_v2.1.jpg')
  })
})

// ---------------------------------------------------------------------------
// ALLOWED_MIMES completeness
// ---------------------------------------------------------------------------

describe('ALLOWED_MIMES', () => {
  const requiredMimes = [
    'image/jpeg', 'image/png', 'image/webp',
    'audio/ogg', 'audio/mpeg',
    'video/mp4',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]

  it.each(requiredMimes)('includes %s', (mime) => {
    expect(ALLOWED_MIMES.has(mime)).toBe(true)
  })

  it('does not include SVG (XSS risk)', () => {
    expect(ALLOWED_MIMES.has('image/svg+xml')).toBe(false)
  })

  it('does not include HTML', () => {
    expect(ALLOWED_MIMES.has('text/html')).toBe(false)
  })
})
