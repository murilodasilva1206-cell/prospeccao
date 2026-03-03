import { Pool } from 'pg'
import { env } from './env'
import { logger } from './logger'

const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: env.DB_SSL
    ? { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
  // Server-side query timeout — strong guard against runaway queries on large tables.
  // Set to 20 s to accommodate COUNT(*) and paginated scans on the 28 M-row cnpj_completo
  // table before the permanent fix (indexes in migration 018) is in place.
  statement_timeout: 20000,
  // Client-side guard — slightly above statement_timeout so the DB error fires first.
  query_timeout: 25000,
})

// Warn at startup when certificate validation is disabled so it is never
// silently overlooked in production logs.
if (env.DB_SSL && !env.DB_SSL_REJECT_UNAUTHORIZED) {
  logger.warn(
    { DB_SSL_REJECT_UNAUTHORIZED: false },
    'DB_SSL_REJECT_UNAUTHORIZED=false: PostgreSQL server certificate will NOT be validated — ensure the network path is trusted',
  )
}

// Surface pool errors to the logger — never swallow them silently
pool.on('error', (err) => {
  logger.error({ err }, 'pg pool idle client error')
})

export default pool
