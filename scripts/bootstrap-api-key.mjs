#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/bootstrap-api-key.mjs
//
// Cria a primeira API key de producao para um workspace e insere o hash no banco.
// A chave raw e impressa UMA VEZ — salve-a imediatamente no seu secret manager.
//
// Uso:
//   node --env-file=.env.local scripts/bootstrap-api-key.mjs [workspace_id] [label]
//
// Argumentos (opcionais — defaults abaixo):
//   workspace_id  ID do workspace (default: "default")
//   label         Descricao da chave   (default: "prod-bootstrap")
//
// Variaveis de ambiente necessarias:
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
//
// Exemplo de producao (Vercel / Render):
//   DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
//     node scripts/bootstrap-api-key.mjs meu-workspace "App Principal"
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'crypto'
import pg from 'pg'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const workspaceId = process.argv[2] ?? 'default'
const label       = process.argv[3] ?? 'prod-bootstrap'

// ---------------------------------------------------------------------------
// DB connection — reads same vars that lib/database.ts uses
// ---------------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production'

const pool = new pg.Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: isProduction ? { rejectUnauthorized: true } : false,
  max: 1,
})

// ---------------------------------------------------------------------------
// Key generation — mirrors lib/whatsapp/auth.ts exactly
// ---------------------------------------------------------------------------
function generateApiKey() {
  const raw     = randomBytes(32).toString('hex')
  const rawKey  = `wk_${raw}`
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex')
  return { rawKey, keyHash }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Bootstrap API Key')
  console.log('=================')
  console.log(`  workspace_id : ${workspaceId}`)
  console.log(`  label        : ${label}`)
  console.log()

  const { rawKey, keyHash } = generateApiKey()

  const client = await pool.connect()
  try {
    const result = await client.query(
      `INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [workspaceId, keyHash, label, 'bootstrap-script'],
    )
    const row = result.rows[0]

    console.log('Chave criada com sucesso!')
    console.log()
    console.log('  ID         :', row.id)
    console.log('  created_at :', row.created_at)
    console.log()
    console.log('RAW KEY (salve agora — nao sera exibida novamente):')
    console.log()
    console.log('  ' + rawKey)
    console.log()
    console.log('Proximos passos:')
    console.log('  1. Salve a RAW KEY no seu secret manager (ex: Vercel env, AWS Secrets Manager)')
    console.log('  2. Nunca armazene a RAW KEY no banco — apenas o hash e guardado la')
    console.log('  3. Use no header: Authorization: Bearer <raw_key>')
    console.log()
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Erro ao criar chave:', err.message)
  process.exit(1)
})
