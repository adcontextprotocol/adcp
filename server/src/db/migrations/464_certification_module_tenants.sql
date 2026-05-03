-- Pin each certification module to the training-agent tenants in scope for
-- its lessons. Sage reads this to steer learners deterministically at the
-- right per-specialism URL (e.g., `/signals/mcp` for B3, `/brand/mcp` +
-- `/governance/mcp` for C2) instead of the legacy single-URL fallback that
-- pre-dated the multi-tenant migration in #3713.
--
-- Order is significant: index 0 is the primary agent Sage hands the learner
-- first; later entries are "also in scope" for tools the primary doesn't
-- serve. NULL means "no pinning — fall back to PUBLIC_TEST_AGENT.url +
-- the `_training_agent_tenants` discovery extension on adagents.json"
-- (today's behavior; safe default for modules we haven't classified yet).
--
-- Tenant ids are short — `sales`, `signals`, `governance`, `creative`,
-- `creative-builder`, `brand` — and resolve to URLs via PUBLIC_TEST_AGENT_URLS
-- at the prompt boundary. Decoupled from canonical hostname.

ALTER TABLE certification_modules
  ADD COLUMN IF NOT EXISTS tenant_ids TEXT[];

COMMENT ON COLUMN certification_modules.tenant_ids IS
  'Ordered list of training-agent tenant ids this module exercises (primary first). NULL = fall back to discovery extension. See server/src/training-agent/tenants/tool-catalog.ts for tool→tenant mapping.';

-- Foundations track — A1/A2 are media-buy-anchored intros, A3 is the tour.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'A1';
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'A2';
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals','governance','creative','brand']    WHERE id = 'A3';

-- Publisher / Seller path.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'B1';
UPDATE certification_modules SET tenant_ids = ARRAY['sales','creative']                                   WHERE id = 'B2';
UPDATE certification_modules SET tenant_ids = ARRAY['signals','sales']                                    WHERE id = 'B3';
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'B4';

-- Buyer / Brand path.
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals','governance']                       WHERE id = 'C1';
UPDATE certification_modules SET tenant_ids = ARRAY['brand','governance']                                 WHERE id = 'C2';
UPDATE certification_modules SET tenant_ids = ARRAY['creative','brand','creative-builder']               WHERE id = 'C3';
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals','brand']                            WHERE id = 'C4';

-- Platform / Intermediary path.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'D1';
UPDATE certification_modules SET tenant_ids = ARRAY['sales','governance']                                 WHERE id = 'D2';
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'D3';
UPDATE certification_modules SET tenant_ids = ARRAY['sales','signals']                                    WHERE id = 'D4';

-- Specialist deep dives.
UPDATE certification_modules SET tenant_ids = ARRAY['sales']                                              WHERE id = 'S1';
UPDATE certification_modules SET tenant_ids = ARRAY['creative','creative-builder']                        WHERE id = 'S2';
UPDATE certification_modules SET tenant_ids = ARRAY['signals']                                            WHERE id = 'S3';
UPDATE certification_modules SET tenant_ids = ARRAY['governance']                                         WHERE id = 'S4';
UPDATE certification_modules SET tenant_ids = ARRAY['brand','creative','governance']                      WHERE id = 'S5';
