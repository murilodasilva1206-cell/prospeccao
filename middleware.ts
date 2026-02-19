import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(_request: NextRequest) {
  const response = NextResponse.next()

  // Content-Security-Policy
  // Restricts which resources the browser will load.
  // 'unsafe-inline' for scripts/styles is needed for Next.js dev; tighten with nonces in future.
  //
  // S3_ENDPOINT is set for Cloudflare R2; S3_REGION for AWS S3.
  // Presigned S3/R2 URLs are used for img-src, media-src and connect-src so the browser
  // can fetch media files directly without proxying through the app server.
  const s3Endpoint = process.env.S3_ENDPOINT
  const s3Region = process.env.S3_REGION ?? 'us-east-1'
  const s3Bucket = process.env.S3_BUCKET ?? ''
  const s3Host = s3Endpoint
    ? new URL(s3Endpoint).hostname
    : `${s3Bucket}.s3.${s3Region}.amazonaws.com`
  const s3Origin = `https://${s3Host}`

  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${s3Origin}`,
      `media-src 'self' ${s3Origin}`,
      `connect-src 'self' https://openrouter.ai ${s3Origin}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  )

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY')

  // Prevent MIME-type sniffing attacks
  response.headers.set('X-Content-Type-Options', 'nosniff')

  // Control how much referrer info is sent
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Disable access to sensitive browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  )

  // HSTS — only set in production (local dev has no valid TLS cert)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    )
  }

  return response
}

export const config = {
  // Apply to all routes except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
