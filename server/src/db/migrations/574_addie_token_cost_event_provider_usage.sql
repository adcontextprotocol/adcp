-- Provider-neutral provenance for the live Addie daily-cost ledger.
--
-- Existing rows and rolling writes from older replicas are Anthropic by
-- construction, so the default preserves their meaning while new live calls
-- persist the canonical provider/model and complete normalized cache usage.

ALTER TABLE addie_token_cost_events
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai', 'google')),
  ADD COLUMN IF NOT EXISTS tokens_cache_creation INTEGER
    CHECK (tokens_cache_creation IS NULL OR tokens_cache_creation >= 0),
  ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER
    CHECK (tokens_cache_read IS NULL OR tokens_cache_read >= 0);

COMMENT ON COLUMN addie_token_cost_events.provider IS
  'Canonical model provider that incurred this live cost event; historical and rolling legacy rows default to anthropic.';
COMMENT ON COLUMN addie_token_cost_events.model IS
  'Exact reviewed model identifier used by the provider-neutral cost-pricing registry.';
COMMENT ON COLUMN addie_token_cost_events.tokens_cache_creation IS
  'Normalized cache-write tokens when reported; NULL means unavailable, not zero.';
COMMENT ON COLUMN addie_token_cost_events.tokens_cache_read IS
  'Normalized cache-read tokens when reported; NULL means unavailable, not zero.';
