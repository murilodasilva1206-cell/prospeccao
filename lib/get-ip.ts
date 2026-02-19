import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Client IP extraction — ordered by trust level per platform.
//
// IMPORTANT: x-forwarded-for can be spoofed by clients unless the platform
// strips/overwrites it. Trust hierarchy:
//
//   Vercel     → sets x-forwarded-for reliably; first IP is the real client
//   Cloudflare → sets cf-connecting-ip; always real client IP (most trusted)
//   Nginx/ALB  → x-forwarded-for rightmost is the real IP
//
// We check cf-connecting-ip first (most trusted), then x-forwarded-for
// (first entry = client on Vercel), then x-real-ip as a last resort.
// ---------------------------------------------------------------------------

// Basic IPv4/IPv6 sanity check — rejects obvious junk but not exhaustive
// eslint-disable-next-line security/detect-unsafe-regex
const IP_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$|^[\da-fA-F:]{2,39}$|^::1$|^::ffff:/

function normalizeIp(raw: string): string {
  const trimmed = raw.trim()
  // Strip IPv6-mapped IPv4 prefix ::ffff:
  return trimmed.replace(/^::ffff:/i, '')
}

function isValidIp(ip: string): boolean {
  return IP_PATTERN.test(ip)
}

export function getClientIp(request: NextRequest): string {
  // 1. Cloudflare: cf-connecting-ip is set by Cloudflare edge and cannot be
  //    spoofed by the client — highest trust.
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp) {
    const normalized = normalizeIp(cfIp)
    if (isValidIp(normalized)) return normalized
  }

  // 2. Vercel / standard reverse proxy: x-forwarded-for, first entry is
  //    the original client. Vercel strips headers forwarded by the client
  //    before adding its own — safe in Vercel context.
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0].trim()
    const normalized = normalizeIp(first)
    if (isValidIp(normalized)) return normalized
  }

  // 3. x-real-ip: set by some proxies (Nginx) as single-value header
  const realIp = request.headers.get('x-real-ip')
  if (realIp) {
    const normalized = normalizeIp(realIp)
    if (isValidIp(normalized)) return normalized
  }

  // Fallback for local dev
  return '127.0.0.1'
}
