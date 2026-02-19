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
