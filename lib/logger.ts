import pino from 'pino'

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    // These paths are replaced with '[Redacted]' before any log is written.
    // pino's fast-redact is compiled at startup — no regex scanning per log line.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'DB_PASSWORD',
      'OPENROUTER_API_KEY',
      'password',
      'email',    // PII — hash before logging if needed for debugging
      'phone',    // PII
      'cpf',      // PII — Brazilian tax ID
      'token',
      'access_token',          // WhatsApp channel credentials
      'api_key',               // WhatsApp channel credentials
      'app_secret',            // WhatsApp Meta app secret
      'webhook_secret',        // HMAC signing secret
      'credentials_encrypted', // AES-GCM blob — never log raw
    ],
    censor: '[Redacted]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined, // in prod: emit newline-delimited JSON for log aggregators
})
