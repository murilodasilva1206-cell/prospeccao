// Runtime environment validation.
// Imports the pure schema from lib/env-schema.ts, parses process.env once at
// module load time, and exits with a descriptive error if any required variable
// is missing or invalid. All other modules import `env` from here.

import { EnvSchema } from './env-schema'

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
