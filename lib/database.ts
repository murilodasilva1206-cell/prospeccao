import { Pool } from 'pg'
import { env } from './env'
import { logger } from './logger'

const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl:
    env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true } // strict cert validation in prod
      : false, // allow local dev without cert
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Server-side query timeout — strongest guard against long-running queries
  statement_timeout: 5000,
  // Client-side timeout (slightly longer than statement_timeout)
  query_timeout: 6000,
})

// Surface pool errors to the logger — never swallow them silently
pool.on('error', (err) => {
  logger.error({ err }, 'pg pool idle client error')
})

export default pool
