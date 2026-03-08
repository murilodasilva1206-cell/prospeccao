// ---------------------------------------------------------------------------
// Media pipeline — validation and S3 storage
//
// Validation chain: MIME allowlist → size limit → magic bytes check
// Storage: private S3 bucket (AWS or Cloudflare R2)
// Access: presigned URLs with 5-minute expiry (never public URLs)
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../env'

// ---------------------------------------------------------------------------
// MIME allowlist — only these types may be uploaded
// ---------------------------------------------------------------------------

export const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/3gpp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])


function getCategory(mime: string): string | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (
    mime === 'application/pdf' ||
    mime === 'text/plain' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'document'
  return null
}

interface MagicSignature {
  bytes: number[]   // expected byte values (use -1 for wildcard)
  offset: number    // byte offset in the file where the signature starts
}

const MAGIC_SIGNATURES: Map<string, MagicSignature[]> = new Map([
  ['image/jpeg', [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }]],
  ['image/png',  [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 }]],
  ['image/gif',  [{ bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 }]],
  [
    'image/webp',
    [
      { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },  // RIFF
      { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },  // WEBP
    ],
  ],
  ['application/pdf', [{ bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }]],  // %PDF
  ['audio/ogg',       [{ bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0 }]],  // OggS
  ['audio/mpeg',      [{ bytes: [0xff, 0xfb], offset: 0 }]],              // MP3
  [
    'video/mp4',
    [
      { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },  // ftyp box at offset 4
    ],
  ],
  ['video/webm', [{ bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0 }]],  // EBML
])

function checkMagicBytes(buffer: Buffer, mime: string): boolean {
  const signatures = MAGIC_SIGNATURES.get(mime)
  if (!signatures) {
    // No magic byte rule for this MIME type — pass through
    // (e.g. text/plain, audio/wav, audio/mp4, image/avif, etc.)
    return true
  }
  for (const sig of signatures) {
    const slice = buffer.slice(sig.offset, sig.offset + sig.bytes.length)
    for (const [idx, expected] of sig.bytes.entries()) {
      if (expected !== -1 && slice.at(idx) !== expected) {
        return false
      }
    }
  }
  return true
}

function getMaxBytes(category: string): number {
  switch (category) {
    case 'image': return 5 * 1024 * 1024
    case 'audio': return 16 * 1024 * 1024
    case 'video': return 16 * 1024 * 1024
    case 'sticker': return 512 * 1024
    default: return 100 * 1024 * 1024
  }
}

function getExtForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/avif': return 'avif'
    case 'audio/ogg': return 'ogg'
    case 'audio/mpeg': return 'mp3'
    case 'audio/mp4': return 'm4a'
    case 'audio/wav': return 'wav'
    case 'audio/webm': return 'webm'
    case 'video/mp4': return 'mp4'
    case 'video/webm': return 'webm'
    case 'video/3gpp': return '3gp'
    case 'application/pdf': return 'pdf'
    case 'text/plain': return 'txt'
    case 'application/msword': return 'doc'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx'
    default: return 'bin'
  }
}

export interface ValidatedMedia {
  mime: string
  size: number
  ext: string
  category: string
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaValidationError'
  }
}

/**
 * Validates a file buffer before upload.
 * Checks: MIME allowlist → size limit → magic bytes.
 * Throws MediaValidationError on any failure.
 */
export function validateMediaFile(buffer: Buffer, declaredMime: string): ValidatedMedia {
  if (buffer.length === 0) {
    throw new MediaValidationError('Empty file')
  }

  const mime = declaredMime.toLowerCase().split(';')[0].trim()

  if (!ALLOWED_MIMES.has(mime)) {
    throw new MediaValidationError(`File type not allowed: ${mime}`)
  }

  const category = getCategory(mime)
  if (!category) {
    throw new MediaValidationError(`Cannot determine category for MIME: ${mime}`)
  }

  const maxBytes = getMaxBytes(category)
  if (buffer.length > maxBytes) {
    const maxMB = (maxBytes / (1024 * 1024)).toFixed(0)
    throw new MediaValidationError(
      `File too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB (max ${maxMB} MB for ${category})`,
    )
  }

  if (!checkMagicBytes(buffer, mime)) {
    throw new MediaValidationError(
      `File content does not match declared MIME type (${mime})`,
    )
  }

  const ext = getExtForMime(mime)
  return { mime, size: buffer.length, ext, category }
}

/** Strips path traversal and control characters from a filename. */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\]/g, '')          // no path separators
    .replace(/\.\./g, '')          // no parent directory traversal
    .replace(/[^\w.\-\s]/g, '_')   // only safe chars
    .slice(0, 255)                  // max 255 chars
    .trim() || 'upload'
}
let _s3Client: S3Client | null = null

export class MediaStorageDisabledError extends Error {
  constructor() {
    super('Media storage is not enabled. Set MEDIA_STORAGE_ENABLED=true and configure S3_* variables.')
    this.name = 'MediaStorageDisabledError'
  }
}

export function createS3Client(): S3Client {
  if (!env.MEDIA_STORAGE_ENABLED) {
    throw new MediaStorageDisabledError()
  }
  if (_s3Client) return _s3Client

  _s3Client = new S3Client({
    region: env.S3_REGION!,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    },
    ...(env.S3_ENDPOINT
      ? {
          endpoint: env.S3_ENDPOINT,
          forcePathStyle: true,  // required for Cloudflare R2
        }
      : {}),
  })

  return _s3Client
}

export interface UploadResult {
  s3Key: string
}

/**
 * Uploads a validated media buffer to S3.
 * Key format: whatsapp/{channelId}/{uuid}.{ext}
 * ACL: private — never public-read.
 */
export async function uploadMedia(
  buffer: Buffer,
  mime: string,
  filename: string,
  channelId: string,
): Promise<UploadResult> {
  const validated = validateMediaFile(buffer, mime)
  const safeFilename = sanitizeFilename(filename)
  const s3Key = `whatsapp/${channelId}/${randomUUID()}-${safeFilename}.${validated.ext}`

  const client = createS3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: validated.mime,
      ContentLength: buffer.length,
      // No ACL — bucket should be private by default
      Metadata: {
        'original-filename': safeFilename,
        'channel-id': channelId,
      },
    }),
  )

  return { s3Key }
}

/**
 * Generates a presigned S3 URL for GET access to a private object.
 * Default expiry: 300 seconds (5 minutes).
 * The client fetches media directly from S3 — never proxied through the app.
 */
export async function getSignedUrl(
  s3Key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const client = createS3Client()
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: s3Key,
  })
  return awsGetSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

/** Deletes a media object from S3. Errors are swallowed (best-effort). */
export async function deleteMedia(s3Key: string): Promise<void> {
  try {
    const client = createS3Client()
    await client.send(
      new DeleteObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: s3Key,
      }),
    )
  } catch {
    // Best-effort — log caller should handle audit
  }
}
