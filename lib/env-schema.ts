// Pure Zod schema for environment variable validation.
// No side-effects — safe to import in tests and tooling without triggering
// process.exit(1). The runtime validation + exit is performed in lib/env.ts.

import { z } from 'zod'

export const EnvSchema = z.object({
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(8, 'DB_PASSWORD must be at least 8 characters'),
  // Optional in production — each workspace configures its own LLM profile.
  // In development, a global fallback key can be set here for convenience.
  // The runtime gate (409 LLM_PROFILE_REQUIRED) handles the production case.
  OPENROUTER_API_KEY: z
    .string()
    .refine((v) => !v || v.startsWith('sk-or-'), {
      message: 'OPENROUTER_API_KEY must start with sk-or- (when set)',
    })
    .default(''),
  OPENROUTER_MODEL: z.string().min(1).default('anthropic/claude-3.5-sonnet'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  // How long (in minutes) a 'processing' lease is held before it can be
  // re-claimed by another worker after a crash or timeout.
  CAMPAIGN_LEASE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(10),

  // PostgreSQL SSL mode. Set to 'false' when the DB server does not support SSL.
  // In production DB_SSL=false is blocked unless ALLOW_INSECURE_DB=true is also set.
  DB_SSL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // When DB_SSL=true, controls whether the server certificate is validated against
  // trusted CAs. Set to 'false' only for self-signed / private-CA certs where you
  // trust the network path (e.g. Render internal network). Defaults to 'true'.
  DB_SSL_REJECT_UNAUTHORIZED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Emergency override: allow DB_SSL=false in production.
  // Must be set explicitly alongside DB_SSL=false — the app refuses to start in
  // production with an unencrypted DB connection unless this is acknowledged.
  ALLOW_INSECURE_DB: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Milliseconds to wait for a connection from the pool before failing.
  // Default 8000 ms — longer than the default 2000 ms to tolerate serverless
  // cold starts and cross-region latency.
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),

  // AES-256-GCM key for encrypting WhatsApp channel credentials at rest.
  // Must be exactly 64 hex characters (= 32 bytes = 256 bits).
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .length(64, 'CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENCRYPTION_KEY must be a valid hex string'),

  // Secret used to authenticate Vercel Cron calls to POST /api/campaigns/process.
  // Must be at least 32 characters. Optional — when absent the cron endpoint
  // returns 503 so the app can still start in development without it.
  CRON_SECRET: z.string().min(32).optional(),

  // Minutes a 'sent' recipient can remain without a delivered/read webhook
  // before the delivery watchdog marks it as failed_timeout.
  // Default 30 minutes. Set to 0 to disable the watchdog.
  DELIVERY_TIMEOUT_MINUTES: z.coerce.number().int().min(0).max(1440).default(30),

  // ---------------------------------------------------------------------------
  // S3-compatible media storage (AWS S3 or Cloudflare R2)
  //
  // Set MEDIA_STORAGE_ENABLED=true to activate the media pipeline.
  // When false (default), the app starts without S3 credentials; media routes
  // respond with a controlled 503 instead of crashing at startup.
  // ---------------------------------------------------------------------------
  MEDIA_STORAGE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Required only when MEDIA_STORAGE_ENABLED=true (validated via superRefine below)
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().optional(),
  // Optional: set for Cloudflare R2 or custom S3-compatible endpoints
  S3_ENDPOINT: z.string().url().optional(),

  // ---------------------------------------------------------------------------
  // Query performance escape valve
  //
  // When true, /api/busca and /api/agente skip the COUNT(*) query entirely and
  // return total: null in the pagination metadata.  Use this as a temporary
  // relief valve on large tables (≥ 10 M rows) while permanent indexes
  // (migration 018) are still being built, or on restricted DB plans where
  // COUNT(*) on cnpj_completo is prohibitively slow.
  //
  // After migration 018 indexes are in place, leave this false (the default).
  // ---------------------------------------------------------------------------
  DB_SKIP_COUNT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
}).superRefine((data, ctx) => {
  // S3 credentials required when media storage is enabled
  if (data.MEDIA_STORAGE_ENABLED) {
    const required: Array<keyof typeof data> = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION']
    for (const key of required) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when MEDIA_STORAGE_ENABLED=true`,
        })
      }
    }
  }

  // Block unencrypted DB connections in production unless explicitly acknowledged.
  // This prevents accidental plaintext DB traffic when DB_SSL is misconfigured.
  if (data.NODE_ENV === 'production' && !data.DB_SSL && !data.ALLOW_INSECURE_DB) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DB_SSL'],
      message:
        'DB_SSL=false is not allowed in production. ' +
        'Set ALLOW_INSECURE_DB=true to acknowledge the risk and override this guard.',
    })
  }
})
