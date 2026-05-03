-- Pin each certification module to the training-agent tenants in scope for
-- its lessons. Sage reads this to steer learners deterministically at the
-- right per-specialism URL (e.g., `/signals/mcp` for S3, `/governance/mcp`
-- for S4) instead of the legacy single-URL alias that pre-dated the
-- multi-tenant migration in #3713.
--
-- Order is significant: index 0 is the primary agent Sage hands the learner
-- first; later entries are "also in scope" for tools the primary doesn't
-- serve. NULL means "no pinning — fall back to PUBLIC_TEST_AGENT.url +
-- the `_training_agent_tenants` discovery extension on adagents.json"
-- (today's behavior; safe default for modules whose curriculum exercises
-- tools we don't yet serve on a per-specialism tenant).
--
-- Tenant ids are short — `sales`, `signals`, `governance`, `creative`,
-- `creative-builder`, `brand` — and resolve to URLs via PUBLIC_TEST_AGENT_URLS
-- at the prompt boundary. Decoupled from canonical hostname.
--
-- DELIBERATELY NULL (left unpinned this round):
--   A3 The AdCP landscape    — tour includes Sponsored Intelligence
--   C3 Creative + SI         — exercises connect_to_si_agent
--   S5 Sponsored Intelligence — entire capstone is the si_* lifecycle
-- The training agent has no tenant that serves `si_*` tools (verified
-- against the local stack — every per-specialism tenant + the legacy
-- `/mcp` alias return zero `si_*` in `tools/list`). Pinning these to
-- sibling tenants would ship a confidently-wrong URL into Sage's prompt;
-- staying on the legacy alias preserves today's behavior until an `si`
-- tenant exists. Tracked as a follow-up.

ALTER TABLE certification_modules
  ADD COLUMN IF NOT EXISTS tenant_ids TEXT[];

COMMENT ON COLUMN certification_modules.tenant_ids IS
  'Ordered list of training-agent tenant ids this module exercises (primary first). NULL = fall back to discovery extension. See server/src/training-agent/tenants/tool-catalog.ts for tool→tenant mapping.';

-- Backfill is conditional on `tenant_ids IS NULL` so a stale DB with
-- hand-edited rows survives a re-run intact. New deploys see this run
-- once via schema_migrations and the guard is a no-op.

-- Foundations track. A1/A2 are media-buy intros. A3 (tour) stays NULL.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']            WHERE id = 'A1' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales']            WHERE id = 'A2' AND tenant_ids IS NULL;

-- Publisher / Seller path. B3 stays publisher-side: signals is a
-- buy-side discovery surface, not where a publisher learner does work.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']            WHERE id = 'B1' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales','creative'] WHERE id = 'B2' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales']            WHERE id = 'B3' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales']            WHERE id = 'B4' AND tenant_ids IS NULL;

-- Buyer / Brand path. C1 drops governance (governance is C2's domain
-- per migration 288's lesson_plan augments — not taught in C1).
-- C3 stays NULL (SI gap). C2 multi-tenant: brand primary, governance second.
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals']           WHERE id = 'C1' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['brand','governance']        WHERE id = 'C2' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals','brand']   WHERE id = 'C4' AND tenant_ids IS NULL;

-- Platform / Intermediary path.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                     WHERE id = 'D1' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales','governance']        WHERE id = 'D2' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                     WHERE id = 'D3' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals']           WHERE id = 'D4' AND tenant_ids IS NULL;

-- Specialist deep dives. S5 stays NULL (SI gap).
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                     WHERE id = 'S1' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['creative','creative-builder'] WHERE id = 'S2' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['signals']                   WHERE id = 'S3' AND tenant_ids IS NULL;
UPDATE certification_modules SET tenant_ids = ARRAY['governance']                WHERE id = 'S4' AND tenant_ids IS NULL;
