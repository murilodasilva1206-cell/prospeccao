#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/generate-seed.mjs
//
// Gera migrations/seed_dev.sql com credentials_encrypted reais (AES-256-GCM),
// cifrados com a CREDENTIALS_ENCRYPTION_KEY do seu ambiente de dev.
//
// Uso:
//   node --env-file=.env.local scripts/generate-seed.mjs
//
// Saida: sobrescreve migrations/seed_dev.sql
// ---------------------------------------------------------------------------

import { createCipheriv, randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../migrations/seed_dev.sql')

// ---------------------------------------------------------------------------
// Encryption - mirrors lib/whatsapp/crypto.ts exactly
// ---------------------------------------------------------------------------
function encryptCredentials(creds) {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    console.error('ERRO: CREDENTIALS_ENCRYPTION_KEY ausente ou invalida (deve ter 64 chars hex).')
    console.error('Execute: node --env-file=.env.local scripts/generate-seed.mjs')
    process.exit(1)
  }
  const key    = Buffer.from(hex, 'hex')
  const iv     = randomBytes(12)          // 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plain  = JSON.stringify(creds)
  const enc    = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('base64')].join(':')
}

// ---------------------------------------------------------------------------
// Dev channel definitions
// Credenciais sao ficticias mas estruturalmente corretas para cada provider.
// workspace_id = 'default' (usado pela tela /whatsapp).
// ---------------------------------------------------------------------------
const CHANNELS = [
  // --- META_CLOUD ---
  {
    name:                 'Default - META Suporte',
    provider:             'META_CLOUD',
    status:               'CONNECTED',
    phone_number:         '+5511900000001',
    external_instance_id: 'meta-phone-id-dev-001',
    last_seen_at:         "NOW() - INTERVAL '3 minutes'",
    creds: {
      access_token:    'dev-meta-access-token-001',
      phone_number_id: 'dev-meta-phone-id-001',
      waba_id:         'dev-meta-waba-id-001',
      app_secret:      'dev-meta-app-secret-001',
    },
  },
  {
    name:                 'Default - META Vendas',
    provider:             'META_CLOUD',
    status:               'DISCONNECTED',
    phone_number:         null,
    external_instance_id: null,
    last_seen_at:         null,
    creds: {
      access_token:    'dev-meta-access-token-002',
      phone_number_id: 'dev-meta-phone-id-002',
      waba_id:         'dev-meta-waba-id-002',
      app_secret:      'dev-meta-app-secret-002',
    },
  },

  // --- EVOLUTION ---
  {
    name:                 'Default - Evolution SDR',
    provider:             'EVOLUTION',
    status:               'CONNECTED',
    phone_number:         '+5521900000001',
    external_instance_id: 'evo-instance-dev-sdr',
    last_seen_at:         "NOW() - INTERVAL '1 minute'",
    creds: {
      instance_url: 'http://localhost:8080',
      api_key:      'dev-evo-api-key-001',
    },
  },
  {
    name:                 'Default - Evolution Marketing',
    provider:             'EVOLUTION',
    status:               'PENDING_QR',
    phone_number:         null,
    external_instance_id: 'evo-instance-dev-mkt',
    last_seen_at:         null,
    creds: {
      instance_url: 'http://localhost:8080',
      api_key:      'dev-evo-api-key-002',
    },
  },
  {
    name:                 'Default - Evolution Bot',
    provider:             'EVOLUTION',
    status:               'ERROR',
    phone_number:         '+5531900000001',
    external_instance_id: 'evo-instance-dev-bot',
    last_seen_at:         "NOW() - INTERVAL '2 hours'",
    creds: {
      instance_url: 'http://localhost:8080',
      api_key:      'dev-evo-api-key-003',
    },
  },

  // --- UAZAPI ---
  {
    name:                 'Default - UAZAPI Atendimento',
    provider:             'UAZAPI',
    status:               'CONNECTED',
    phone_number:         '+5541900000001',
    external_instance_id: 'uazapi-dev-atendimento',
    last_seen_at:         "NOW() - INTERVAL '30 seconds'",
    creds: {
      instance_url: 'http://localhost:9090',
      api_key:      'dev-uazapi-key-001',
    },
  },
  {
    name:                 'Default - UAZAPI Cobranca',
    provider:             'UAZAPI',
    status:               'CONNECTING',
    phone_number:         null,
    external_instance_id: 'uazapi-dev-cobranca',
    last_seen_at:         null,
    creds: {
      instance_url: 'http://localhost:9090',
      api_key:      'dev-uazapi-key-002',
    },
  },
]

// ---------------------------------------------------------------------------
// Build SQL
// ---------------------------------------------------------------------------
function sqlLiteral(v) {
  if (v === null)           return 'NULL'
  if (v.startsWith('NOW()')) return v
  return `'${v.replace(/'/g, "''")}'`
}

const rows = CHANNELS.map((ch) => {
  const credBlob   = encryptCredentials(ch.creds)
  const webhookSec = randomBytes(32).toString('hex')

  return `(
    gen_random_uuid(),
    'default',
    ${sqlLiteral(ch.name)},
    '${ch.provider}',
    '${ch.status}',
    ${sqlLiteral(ch.phone_number)},
    ${sqlLiteral(ch.external_instance_id)},
    '${credBlob}',
    '${webhookSec}',
    ${ch.last_seen_at ? ch.last_seen_at : 'NULL'}
  )`
})

const sql = `-- ============================================================
-- SEED DEV - gerado por scripts/generate-seed.mjs em ${new Date().toISOString()}
-- NAO edite manualmente: blobs AES-GCM sao atrelados a CREDENTIALS_ENCRYPTION_KEY
-- do ambiente em que este script foi executado.
--
-- Para regenerar: node --env-file=.env.local scripts/generate-seed.mjs
-- ============================================================

TRUNCATE whatsapp_channels CASCADE;

INSERT INTO whatsapp_channels (
  id,
  workspace_id,
  name,
  provider,
  status,
  phone_number,
  external_instance_id,
  credentials_encrypted,
  webhook_secret,
  last_seen_at
) VALUES
${rows.join(',\n')};

-- Distribuicao apos seed:
-- workspace_id = 'default' para todos os 7 canais
-- CONNECTED    : 3 (META Suporte, Evolution SDR, UAZAPI Atendimento)
-- DISCONNECTED : 1 (META Vendas)
-- PENDING_QR   : 1 (Evolution Marketing)
-- CONNECTING   : 1 (UAZAPI Cobranca)
-- ERROR        : 1 (Evolution Bot)
`

writeFileSync(OUT, sql, 'utf8')
console.log('OK Seed gerado: ' + OUT)
console.log('   Canais: ' + CHANNELS.length + ' | workspace_id: default')
console.log()
console.log('Proximo passo - executar contra o banco:')
console.log('  "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" -h HOST -p PORT -U postgres -d prospeccao_dev -f migrations/seed_dev.sql')
