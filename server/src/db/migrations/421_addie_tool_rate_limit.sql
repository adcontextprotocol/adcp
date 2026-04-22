-- Shared state for the per-user Addie tool-call rate limiter so caps are
-- bounded across multiple Fly.io app instances. Prior to this migration
-- the limiter held its state in an in-process Map, which meant a user
-- fanned across N pods effectively got N× the advertised global cap
-- (issue #2789, surfaced in PR #2784 review).
--
-- Each row is one tool invocation. `scope_key` encodes the counter
-- scope: `${userId}|${toolName}` (per-tool), `${userId}|*` (global per
-- user), or `__workspace__|${toolName}` (workspace-aggregate).
--
-- The limiter trims rows older than the relevant window before counting,
-- and a weekly sweep keeps the table bounded for stale keys.

CREATE TABLE IF NOT EXISTS addie_tool_rate_limit_events (
  id         BIGSERIAL PRIMARY KEY,
  scope_key  TEXT        NOT NULL,
  hit_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addie_rate_limit_key_time
  ON addie_tool_rate_limit_events (scope_key, hit_at DESC);

-- Lets the periodic cleanup scan find expired rows efficiently without
-- needing to know the key.
CREATE INDEX IF NOT EXISTS idx_addie_rate_limit_hit_at
  ON addie_tool_rate_limit_events (hit_at);
