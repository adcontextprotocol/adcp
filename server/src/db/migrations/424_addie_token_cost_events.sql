-- Shared per-user Claude API cost tracking for the Addie cost cap
-- (#2790). Tool-call frequency limits (#2784, #2789) bound our external
-- API spend (Google, Gemini, Slack) but don't bound Anthropic spend —
-- a determined attacker with a compromised account can keep a session
-- running that drives real dollars on Claude.
--
-- Each row is one claude-client response. `scope_key` encodes the
-- counter scope: `${userId}` is the only scope today (per-user daily
-- budget); the column is a text key so a future workspace-aggregate
-- cap (mirroring #2796) can add rows under `__workspace__` without
-- schema changes.
--
-- `cost_usd_micros` is the computed cost for this response in
-- millionths of a dollar (e.g., $0.001 = 1,000 micros). Storing as
-- BIGINT integer avoids floating-point rounding when summing a day's
-- worth of tiny calls — a Claude call costs ~100-10,000 micros
-- depending on tokens + model, and a 24h window for a single user
-- is always well under BIGINT range.

CREATE TABLE IF NOT EXISTS addie_token_cost_events (
  id                BIGSERIAL PRIMARY KEY,
  scope_key         TEXT        NOT NULL,
  cost_usd_micros   BIGINT      NOT NULL,
  model             TEXT        NOT NULL,
  tokens_input      INTEGER     NOT NULL,
  tokens_output     INTEGER     NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addie_token_cost_scope_time
  ON addie_token_cost_events (scope_key, recorded_at DESC);

-- For the periodic cleanup sweep.
CREATE INDEX IF NOT EXISTS idx_addie_token_cost_recorded_at
  ON addie_token_cost_events (recorded_at);
