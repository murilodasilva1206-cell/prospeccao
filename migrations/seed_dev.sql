-- ============================================================
-- SEED DEV - gerado por scripts/generate-seed.mjs em 2026-02-19T23:18:13.028Z
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
(
    gen_random_uuid(),
    'default',
    'Default - META Suporte',
    'META_CLOUD',
    'CONNECTED',
    '+5511900000001',
    'meta-phone-id-dev-001',
    'e6983f51f9b70b73b920fbdf:e69b9608d00087878bcb4b21943f69b3:fPNSJ/lLbd2gTj8k3hpfZpRrI/1qNgnJ8bvYA8Tu+RWd2m5tr22d0Ge6LBecQfQSmWRuTHbo8G5+pdP3uZnJdj0K1DLsiRjfBYaK4GRz4i9J41kVGHCwXMnLPuqFXFrLlxjku1X1LWyxAgQ+nrBv0MadOPbUL/D/O9KIw/+knPKjBFchImVpaKay/asgDtY8OyJFniBmwTDykv5GsWM=',
    '25696133d8367d040ca0fdcc720a8d15d75bb88311eefde86f957fc29b8bb28e',
    NOW() - INTERVAL '3 minutes'
  ),
(
    gen_random_uuid(),
    'default',
    'Default - META Vendas',
    'META_CLOUD',
    'DISCONNECTED',
    NULL,
    NULL,
    '967314faf4faf75606bfcc50:50293b0e5bf14ea5a3af8ac5a1671edb:UZxC93zHfZK6ErkXrOn3L2t6TqV+eA3l9wZtPT2JygOeQj1rv/vcYy1Jgd0wuy/fx2jdTDB0mKWxdWvhcPeNQtK6jt5pqla9LO+ZIZjQyaQ4bzSQeJQG9ba2zHgJpa5iEZDXjmjzP5ID7S9W+xVqHR5Fj44dynjPlVh/NHXN7B7/mN1mqIPTmhD8eRcD0w9LPlhsPW8has+9ROuV8vE=',
    '1838e447326e41ab5bb25e318ad921e8db1112649bc0fdb58dd5e8c22b7a7dae',
    NULL
  ),
(
    gen_random_uuid(),
    'default',
    'Default - Evolution SDR',
    'EVOLUTION',
    'CONNECTED',
    '+5521900000001',
    'evo-instance-dev-sdr',
    '33f570bd05eb5258975e9f66:a7f3a4ca426df09e1a984bee63598d47:UZ/e2IR9w5f8lBfeNiO6gzQ0gqGOhqX5tYoipUgu8rok1JMBVpk4ialNRH+er09yloXOezChJBZOTGWgjCg3QNHYStpfIfBj',
    '26d0f44b6bcd5f136be4f5ef3e0bd3a0fa1670d78a049ded251148d83301b38a',
    NOW() - INTERVAL '1 minute'
  ),
(
    gen_random_uuid(),
    'default',
    'Default - Evolution Marketing',
    'EVOLUTION',
    'PENDING_QR',
    NULL,
    'evo-instance-dev-mkt',
    '15cb3a0a6dd549d92471b3df:41eba75cec5b786c178d10b39d73ef30:uEYvRlk7CFqBmUMhhBl1iYI1X38TA81N3tqtLUnsNVf16o/hUGrou7MtStR5I8zPSiH5hT/8MtQp/2pc2v+Y4oqU7E0ABPag',
    '37d7d5234cc8eb1b019dcc80bb19798370706cc5e33d663d15ca2e60db9ea2f3',
    NULL
  ),
(
    gen_random_uuid(),
    'default',
    'Default - Evolution Bot',
    'EVOLUTION',
    'ERROR',
    '+5531900000001',
    'evo-instance-dev-bot',
    'c4d811d69fea717dada1eb0a:74f855c92dca122ca73bb35e1edffa47:AyzLjG3mFE3w9rPA7usoUwwAa/K2aQlcBisFhelyUc00dhBYzumELXS/P2o1L1AHT3NAZIUJhMimOghKhzlYP/AKrdefnauK',
    'f89e32a8e5ab0f45479f731f2dbbb4c006a7989c1c185b042cd8e5a069d0d837',
    NOW() - INTERVAL '2 hours'
  ),
(
    gen_random_uuid(),
    'default',
    'Default - UAZAPI Atendimento',
    'UAZAPI',
    'CONNECTED',
    '+5541900000001',
    'uazapi-dev-atendimento',
    'dfeae173bd4137239b5bb3fd:e31e790b8cf798578955af821396d4dd:UGqRcNFg475vQemAGfOCOBmyh4HgMwegZogVsnqtIK70HzOM8Vw72Qof4pOmgOVhV/1t0Vmx2oJyc4cYvQzVV8qrW+cVq3A=',
    'b3062b4881cace6137df8dba7b5ed1e6e45833892127b1b9ac4406aeec669511',
    NOW() - INTERVAL '30 seconds'
  ),
(
    gen_random_uuid(),
    'default',
    'Default - UAZAPI Cobranca',
    'UAZAPI',
    'CONNECTING',
    NULL,
    'uazapi-dev-cobranca',
    '9730ba086dd9ad3ed8fe7a40:38c392581a368a48fb8e91f78a9f0e70:V4yfIt34sktVHvmKLhPaLQoGOveRyvXEgiKOu9FeM4N+rdh+JnuGziN+jlwCEG+a5eatDDbWeSg5wVbv+C3DbcUJwSnp/KY=',
    'd3c8820fe2bce5a0a1ea8e31939ee4021dda756989db108a3a6fa648eac3a31d',
    NULL
  );

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
