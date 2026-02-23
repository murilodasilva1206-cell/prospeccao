import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const SESSION_COOKIE = 'session'
const SESSION_EXP_COOKIE = 'session_exp'

export function proxy(_request: NextRequest) {
  const pathname = _request.nextUrl.pathname

  // ---------------------------------------------------------------------------
  // Route protection: redirect unauthenticated/expired users to /login.
  // Applies only to page routes under /whatsapp (not /api/*, not /login itself).
  //
  // Two-tier design — intentional, no DB access at the Edge:
  //
  //   Tier 1 (Edge middleware — this file):
  //     Checks cookie presence + session_exp companion cookie (unix timestamp).
  //     Fast: no DB round-trip, runs on every navigation.
  //     Limitation: cannot detect sessions revoked server-side (e.g. logout on
  //     another device) because the HttpOnly cookie may still be present.
  //     An attacker who forges `session_exp` can bypass this redirect, but they
  //     still cannot forge `session` — all API calls will 401.
  //
  //   Tier 2 (WhatsApp layout client component — app/whatsapp/layout.tsx):
  //     Calls /api/auth/me on mount; redirects to /login if 401 is returned.
  //     Catches revoked/invalid sessions that slipped past Tier 1.
  //     Also used by AuthProvider.refreshSession() after login to avoid the
  //     race where user=null causes a bounce-back to /login.
  //
  //   Security boundary: all protected API routes call requireWorkspaceAuth()
  //   which validates the session token against the DB — that is the true gate.
  //   The middleware and layout redirects are UX guards, not security controls.
  // ---------------------------------------------------------------------------
  if (pathname.startsWith('/whatsapp')) {
    const hasSession = _request.cookies.has(SESSION_COOKIE)
    if (!hasSession) {
      const loginUrl = new URL('/login', _request.url)
      loginUrl.searchParams.set('from', pathname)
      return NextResponse.redirect(loginUrl)
    }

    // Check whether the session has expired via the companion cookie.
    const expRaw = _request.cookies.get(SESSION_EXP_COOKIE)?.value
    if (expRaw) {
      const expTimestamp = parseInt(expRaw, 10)
      if (!isNaN(expTimestamp) && expTimestamp < Math.floor(Date.now() / 1000)) {
        const loginUrl = new URL('/login', _request.url)
        loginUrl.searchParams.set('from', pathname)
        return NextResponse.redirect(loginUrl)
      }
    }
  }

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
