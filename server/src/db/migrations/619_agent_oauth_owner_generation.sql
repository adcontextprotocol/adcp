-- Owner authorization completion and explicit OAuth disconnect advance this
-- fence even when credential columns were already NULL. No credential/issuer
-- backfill and no generic updated_at or distributed refresh lock.
ALTER TABLE agent_contexts
  ADD COLUMN IF NOT EXISTS oauth_owner_generation BIGINT NOT NULL DEFAULT 0;
