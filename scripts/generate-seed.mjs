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

-- ============================================================
-- API KEY de dev (SHA-256 de "wk_devkey_placeholder_for_local_testing_only")
-- NUNCA usar em producao
-- ============================================================
INSERT INTO workspace_api_keys (workspace_id, key_hash, label, created_by)
VALUES (
  'default',
  encode(sha256('wk_devkey_placeholder_for_local_testing_only'::bytea), 'hex'),
  'Dev Local Key',
  'seed-script'
) ON CONFLICT (key_hash) DO NOTHING;

-- ============================================================
-- Conversations de exemplo (referenciam os canais CONNECTED acima)
-- canal META Suporte (primeiro INSERT), Evolution SDR (terceiro), UAZAPI Atendimento (sexto)
-- Usamos CTEs para pegar os IDs dos canais por nome.
-- ============================================================
WITH
  meta_ch AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - META Suporte' LIMIT 1),
  evo_ch  AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - Evolution SDR' LIMIT 1),
  uaz_ch  AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - UAZAPI Atendimento' LIMIT 1),

  conv_insert AS (
    INSERT INTO conversations
      (id, channel_id, workspace_id, contact_phone, contact_name, status, unread_count, ai_enabled, last_message_at)
    VALUES
      -- Conversa 1: META, texto, aberta, 2 nao lidas
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       (SELECT id FROM meta_ch), 'default',
       '5511999990001', 'Ana Costa', 'open', 2, false,
       NOW() - INTERVAL '5 minutes'),
      -- Conversa 2: META, imagem, ai_handled
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       (SELECT id FROM meta_ch), 'default',
       '5511988880002', 'Bruno Lima', 'ai_handled', 0, true,
       NOW() - INTERVAL '1 hour'),
      -- Conversa 3: Evolution, audio, resolvida
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
       (SELECT id FROM evo_ch), 'default',
       '5521977770003', 'Carlos Mendes', 'resolved', 0, false,
       NOW() - INTERVAL '2 hours'),
      -- Conversa 4: Evolution, aberta, IA ligada
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
       (SELECT id FROM evo_ch), 'default',
       '5521966660004', 'Daniela Rocha', 'open', 5, true,
       NOW() - INTERVAL '2 minutes'),
      -- Conversa 5: UAZAPI, documento, aberta
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
       (SELECT id FROM uaz_ch), 'default',
       '5541955550005', 'Eduardo Pires', 'open', 1, false,
       NOW() - INTERVAL '15 minutes')
    ON CONFLICT (channel_id, contact_phone) DO NOTHING
    RETURNING id, contact_name
  )
SELECT id, contact_name FROM conv_insert;

-- ============================================================
-- Messages de exemplo (referenciam as conversations acima)
-- ============================================================
WITH
  meta_ch AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - META Suporte' LIMIT 1),
  evo_ch  AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - Evolution SDR' LIMIT 1),
  uaz_ch  AS (SELECT id FROM whatsapp_channels WHERE name = 'Default - UAZAPI Atendimento' LIMIT 1)

INSERT INTO messages
  (id, conversation_id, channel_id, provider_message_id,
   direction, message_type, status, body, sent_by, created_at)
VALUES
  -- Conversa 1 (Ana Costa, META)
  ('11111111-1111-4111-8111-111111111101',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (SELECT id FROM meta_ch),
   'wamid.seed001',
   'inbound', 'text', 'read',
   'Ola, preciso de ajuda com meu pedido', 'webhook',
   NOW() - INTERVAL '10 minutes'),
  ('11111111-1111-4111-8111-111111111102',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (SELECT id FROM meta_ch),
   'wamid.seed002',
   'outbound', 'text', 'delivered',
   'Ola Ana! Fico feliz em ajudar. Qual e o numero do seu pedido?', 'human:seed',
   NOW() - INTERVAL '9 minutes'),
  ('11111111-1111-4111-8111-111111111103',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (SELECT id FROM meta_ch),
   'wamid.seed003',
   'inbound', 'text', 'read',
   'E o pedido #12345', 'webhook',
   NOW() - INTERVAL '7 minutes'),
  ('11111111-1111-4111-8111-111111111104',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (SELECT id FROM meta_ch),
   'wamid.seed004',
   'inbound', 'text', 'read',
   'Pode verificar por favor?', 'webhook',
   NOW() - INTERVAL '5 minutes'),

  -- Conversa 2 (Bruno Lima, META, IA)
  ('22222222-2222-4222-8222-222222222201',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', (SELECT id FROM meta_ch),
   'wamid.seed010',
   'inbound', 'text', 'read',
   'Quais sao os horarios de atendimento?', 'webhook',
   NOW() - INTERVAL '90 minutes'),
  ('22222222-2222-4222-8222-222222222202',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', (SELECT id FROM meta_ch),
   'wamid.seed011',
   'outbound', 'text', 'read',
   'Atendemos de segunda a sexta das 8h as 18h e sabados das 9h ao 12h.', 'ai',
   NOW() - INTERVAL '89 minutes'),

  -- Conversa 3 (Carlos Mendes, Evolution, resolvida)
  ('33333333-3333-4333-8333-333333333301',
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc', (SELECT id FROM evo_ch),
   'evo-seed-001',
   'inbound', 'audio', 'read',
   NULL, 'webhook',
   NOW() - INTERVAL '3 hours'),
  ('33333333-3333-4333-8333-333333333302',
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc', (SELECT id FROM evo_ch),
   'evo-seed-002',
   'outbound', 'text', 'read',
   'Entendido Carlos! Problema resolvido. Pode nos contatar novamente se precisar.', 'human:seed',
   NOW() - INTERVAL '2 hours 30 minutes'),

  -- Conversa 4 (Daniela Rocha, Evolution, IA ativa)
  ('44444444-4444-4444-8444-444444444401',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-010',
   'inbound', 'text', 'read',
   'Boa tarde! Gostaria de saber sobre os planos disponiveis', 'webhook',
   NOW() - INTERVAL '20 minutes'),
  ('44444444-4444-4444-8444-444444444402',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-011',
   'outbound', 'text', 'delivered',
   'Boa tarde Daniela! Temos 3 planos: Basic, Pro e Enterprise. Posso detalhar cada um?', 'ai',
   NOW() - INTERVAL '19 minutes'),
  ('44444444-4444-4444-8444-444444444403',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-012',
   'inbound', 'text', 'read',
   'Sim por favor, quero saber sobre o Pro', 'webhook',
   NOW() - INTERVAL '15 minutes'),
  ('44444444-4444-4444-8444-444444444404',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-013',
   'inbound', 'text', 'read',
   'E qual e o preco?', 'webhook',
   NOW() - INTERVAL '10 minutes'),
  ('44444444-4444-4444-8444-444444444405',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-014',
   'inbound', 'text', 'read',
   'Tem periodo de teste?', 'webhook',
   NOW() - INTERVAL '5 minutes'),
  ('44444444-4444-4444-8444-444444444406',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', (SELECT id FROM evo_ch),
   'evo-seed-015',
   'inbound', 'text', 'delivered',
   'Pode me ligar?', 'webhook',
   NOW() - INTERVAL '2 minutes'),

  -- Conversa 5 (Eduardo Pires, UAZAPI, documento)
  ('55555555-5555-4555-8555-555555555501',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', (SELECT id FROM uaz_ch),
   'uaz-seed-001',
   'inbound', 'document', 'read',
   'Proposta comercial', 'webhook',
   NOW() - INTERVAL '20 minutes'),
  ('55555555-5555-4555-8555-555555555502',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', (SELECT id FROM uaz_ch),
   'uaz-seed-002',
   'outbound', 'text', 'sent',
   'Eduardo, recebi o documento! Vou analisar e retorno em breve.', 'human:seed',
   NOW() - INTERVAL '15 minutes'),
  ('55555555-5555-4555-8555-555555555503',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', (SELECT id FROM uaz_ch),
   'uaz-seed-003',
   'inbound', 'text', 'delivered',
   'Ok, aguardo!', 'webhook',
   NOW() - INTERVAL '14 minutes')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Distribuicao apos seed:
-- workspace_id = 'default' para todos os 7 canais
-- CONNECTED    : 3 (META Suporte, Evolution SDR, UAZAPI Atendimento)
-- DISCONNECTED : 1 (META Vendas)
-- PENDING_QR   : 1 (Evolution Marketing)
-- CONNECTING   : 1 (UAZAPI Cobranca)
-- ERROR        : 1 (Evolution Bot)
-- Conversations: 5 | open:3 resolved:1 ai_handled:1
-- Messages    : 17 (text, audio, document, inbound+outbound)
-- ============================================================
`

writeFileSync(OUT, sql, 'utf8')
console.log('OK Seed gerado: ' + OUT)
console.log('   Canais      : ' + CHANNELS.length + ' | workspace_id: default')
console.log('   Conversations: 5 (open:3 resolved:1 ai_handled:1)')
console.log('   Messages     : 17 (text/audio/document | inbound+outbound)')
console.log()
console.log('Proximo passo - executar contra o banco:')
console.log('  "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" -h HOST -p PORT -U postgres -d prospeccao_dev -f migrations/seed_dev.sql')
console.log()
console.log('API key de dev (para usar no inbox):')
console.log('  Chave raw : wk_devkey_placeholder_for_local_testing_only')
console.log('  No browser: localStorage.setItem("wk_api_key", "wk_devkey_placeholder_for_local_testing_only")')
