-- Per-step diagnostic capture for compliance runs (adcp#4738).
--
-- Sellers debugging failing compliance verdicts cannot today see the exact
-- request the runner sent or the exact response their agent returned. They
-- replay storyboards by hand against their own auth/account, the calls pass,
-- and we end up triangulating against a hypothesised "scoring engine cache"
-- that does not exist. The actual divergence is usually that the runner's
-- request body (account, brand, correlation_id, idempotency_key) differs from
-- whatever the seller probed with.
--
-- The SDK already records the exact wire request and response on every step
-- (RunnerRequestRecord / RunnerResponseRecord on StoryboardStepResult). We
-- just don't persist it. This table captures the failing steps so owners can
-- diff their probe against the runner's call without filing a ticket.
--
-- Policy: only failing (non-skipped) steps are captured. Skipped steps carry
-- no wire payload by construction; passing steps would balloon storage
-- without diagnostic value. If we need to widen later, the `step_passed`
-- column lets us include sampled passing rows without a schema change.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_compliance_step_diagnostics (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_compliance_runs(id) ON DELETE CASCADE,
  agent_url TEXT NOT NULL,

  storyboard_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  task TEXT NOT NULL,

  step_passed BOOLEAN NOT NULL,
  duration_ms INTEGER,

  -- Wire payloads (capped client-side; see compliance-testing.ts).
  -- request_jsonb is what the runner sent; response_jsonb is the parsed body
  -- the runner observed. Headers omitted from request (SDK refuses to surface
  -- Authorization bearers); response headers retained for content-type and
  -- cache-control surfaces.
  request_url TEXT,
  request_jsonb JSONB,
  response_status INTEGER,
  response_headers_jsonb JSONB,
  response_jsonb JSONB,

  -- Provenance of the parsed response (structured_content / text_fallback /
  -- error / none). Lets implementors distinguish runner extraction bugs
  -- from agent bugs without re-running.
  extraction_path TEXT,
  extraction_note TEXT,

  -- Failure context.
  error_text TEXT,
  adcp_error_jsonb JSONB,
  failed_validations_jsonb JSONB,

  -- Multi-instance routing — which replica served this step.
  served_by_agent_url TEXT,

  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner debug flow: "show me the failing steps from the latest run for this
-- agent." Hits run_id directly; outer join from agent_compliance_runs by id.
CREATE INDEX IF NOT EXISTS idx_compliance_step_diag_run
  ON agent_compliance_step_diagnostics(run_id);

-- Cross-run regression flow: "has this step been failing the same way for
-- the last N runs?" Lets the owner spot deterministic failures vs flakes.
CREATE INDEX IF NOT EXISTS idx_compliance_step_diag_agent_step_time
  ON agent_compliance_step_diagnostics(agent_url, storyboard_id, step_id, captured_at DESC);

COMMIT;
