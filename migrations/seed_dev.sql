-- ============================================================
-- SEED DEV - gerado por scripts/generate-seed.mjs em 2026-02-19T16:15:37.017Z
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
    '94ba5dab7d66564c22d800f1:d1cf5c27879fa1e5e67c82c0b8c9f6fe:yDs9Mxr/IGNYjXA2yALVJzMi0N1zl3oI2j121Gn0jQtTtZ9Hw+hSfrgvOKok2qFqIzIdKQPdBg6JG+Lyy/ol4Xf+Rf1lbtiQZ8IM03P6jn0iGq70fv5i5MGHTqMEogRgGeQIM1tbetV8NQ9M9xas6CXRceydEu6FLXoQfKBlPwUtUSIRRNynhDqH04RhLf8a+Wk5zvIO6+nUBUDNMwI=',
    'cb1708a20d430869ca8fbc4a59a7acf0572eab2c8abeae93fd85c85cb1a211e6',
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
    'cbae5246e2ec9abd7db72320:6d9bc1d5f30cff718f5d86c12a0fe134:WldTrGXHgrAuuWOafLDaE1OBJxxLMClV+cKf2/gruCmRdysRMa+pJUYvncZhJDkU4JjFg28e65TMxx8dQ4ZOeBWik3WXRc/jJcoiw8O1K6xOWWUSoAC4KhNgHhEYe7D5yIOzBIwFVEbL8yv0BBEUH67gW1KJWxb+sw7bz6G9HI6UKx0uBsZnh7FNq/MK6Ue+Njz6DDg749Ak74+prO8=',
    '8f7a063b5c6fc41c0d17ee13306c30b847849c4aa5972bb030e346e417b6532e',
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
    '491de0e1b4bf4b32b4e266cc:46075d594f1063d8b0355a0427c0a98d:XTaY8wXzTbwADZcWloKi3/1LUWyjTbCL4gzCtELSLFcp94JfT6wqczUXRes6PQPeXsVYzIuiSiyqOXQPmBK8/gKXcDgjHz7N',
    '4de2154bcaab4c00db5498119a453304db6a9c31560c981a267562ece8c90114',
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
    '89cebbc6de4480513f60f8bd:207220698cbb63505018fce3464de047:70gvENa5DazVUlZjWENjTFgRN/tZDudU9RFQ2bY3NFpoaqjQwiVQFClED+z+5yFkmCsEqsAQmjg0/a1qh6B8K5z+OhZQ5D6f',
    '654a5f0ad6a2389f0486ab84d2a3baa06c4aaaff8e7ee3cfef52bbcc157231dd',
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
    '9badbfcb1788561c3df39c89:80138ff6d850e9b51b92eb0e51ca3b42:XtxFekvjK9pYpp0qsPwNfuawXs234eV56hgsOz5i2rn03ZiPYbdPR1hZ+8Ivn5ePWOB+Zai1Jy06kno9mqPRjHLvtpfLydSC',
    'de5a46782e46404011a2acdf75ab3ffce99a75f295ad76d3946c161d74e944e0',
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
    '589f6b8d8e3cb0ca4b54d8e1:e45f998139a9369400ab624d7fb202b7:8SZoM1Vss/Mpxy2Hne0W/Nv7sQgImKexAijYbchPwSoUUeOrPk7aVpHigcE7B7/ng9N9y3h/n714GSZMM0G2/QAobk75jsc=',
    'b0f5bf1e48280b15364de60d4e6f8203b63506914a6f39446aa0608a3f5a4332',
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
    '7723599a02968c0a110b5ac1:f25c0cf032c5242e9f276d2fb4d160f1:BrKeGxLUCQTU+ur+8rmA0hvUM8rHVh5RboyU2gAWkOFiJHZxvSZ52nOdnkWncPjhwHx5UVPSvKyH3SA4uuIoiPNADhwbp4k=',
    'f2d63a281c8eecce1a34a82398770bbd56c2a11cf7625eeca6b0347f748d9edb',
    NULL
  );

-- Distribuicao apos seed:
-- workspace_id = 'default' para todos os 7 canais
-- CONNECTED    : 3 (META Suporte, Evolution SDR, UAZAPI Atendimento)
-- DISCONNECTED : 1 (META Vendas)
-- PENDING_QR   : 1 (Evolution Marketing)
-- CONNECTING   : 1 (UAZAPI Cobranca)
-- ERROR        : 1 (Evolution Bot)
