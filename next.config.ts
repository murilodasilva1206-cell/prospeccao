import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Remove the X-Powered-By: Next.js header to reduce information disclosure
  poweredByHeader: false,

  compress: true,

  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          // API responses must never be cached by CDN or browser
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },

  // Keep server-only packages out of the client bundle
  serverExternalPackages: ['pg', 'pino', 'pino-pretty'],
}

export default nextConfig
