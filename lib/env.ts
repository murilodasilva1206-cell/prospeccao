import { z } from 'zod'

const EnvSchema = z.object({
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(8, 'DB_PASSWORD must be at least 8 characters'),
  OPENROUTER_API_KEY: z
    .string()
    .min(1, 'OPENROUTER_API_KEY is required')
    .refine((v) => v.startsWith('sk-or-'), {
      message: 'OPENROUTER_API_KEY must start with sk-or-',
    }),
  OPENROUTER_MODEL: z.string().min(1).default('anthropic/claude-3.5-sonnet'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  // AES-256-GCM key for encrypting WhatsApp channel credentials at rest.
  // Must be exactly 64 hex characters (= 32 bytes = 256 bits).
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .length(64, 'CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENCRYPTION_KEY must be a valid hex string'),

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
}).superRefine((data, ctx) => {
  if (!data.MEDIA_STORAGE_ENABLED) return
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
})

// parse() throws ZodError at module load time if any required var is missing
// — the app refuses to start with an invalid configuration.
const _parsed = EnvSchema.safeParse(process.env)

if (!_parsed.success) {
  console.error('❌ Invalid environment variables:')
  _parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  })
  process.exit(1)
}

export const env = _parsed.data
