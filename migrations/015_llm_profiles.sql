-- Migration 015: LLM profiles per workspace
-- Allows each workspace to configure its own LLM provider, API key, and model.
-- API keys are stored encrypted (AES-256-GCM, same scheme as whatsapp_channels).
-- The raw key is never returned to clients — only a key_hint (last 4 chars).

CREATE TABLE llm_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  provider          TEXT        NOT NULL
    CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'google')),
  api_key_encrypted TEXT        NOT NULL,   -- AES-256-GCM: ivHex:authTagHex:ciphertextBase64
  model             TEXT        NOT NULL,
  base_url          TEXT,                   -- NULL = provider default
  is_default        BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each workspace can have at most one profile with any given name
CREATE UNIQUE INDEX llm_profiles_workspace_name_idx
  ON llm_profiles(workspace_id, name);

-- Each workspace can have at most one default profile
CREATE UNIQUE INDEX llm_profiles_workspace_default_idx
  ON llm_profiles(workspace_id)
  WHERE is_default = true;

-- Fast lookup: list all profiles for a workspace
CREATE INDEX llm_profiles_workspace_id_idx
  ON llm_profiles(workspace_id);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_llm_profiles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_llm_profiles_updated_at
  BEFORE UPDATE ON llm_profiles
  FOR EACH ROW EXECUTE FUNCTION set_llm_profiles_updated_at();
