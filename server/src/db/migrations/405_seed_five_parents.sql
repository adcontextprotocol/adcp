-- Seed the five top-level parent working groups for the consolidation described
-- in specs/committee-hierarchy.md. Idempotent on slug conflict so re-running is safe.

INSERT INTO working_groups (name, slug, description, committee_type, status, display_order, is_private, topics)
VALUES
  ('Campaign Lifecycle', 'wg-campaign-lifecycle',
   'Discovery, proposals, execution, trafficking, pacing, makegoods, reconciliation. The full arc from finding inventory through reconciling the buy.',
   'working_group', 'active', 10, false, '[]'::jsonb),
  ('Creative', 'wg-creative',
   'Creative lifecycle, generative creative, governance, and audit.',
   'working_group', 'active', 20, false, '[]'::jsonb),
  ('Signals and Measurement', 'wg-signals-measurement',
   'Audience signals, measurement, verification, attribution.',
   'working_group', 'active', 30, false, '[]'::jsonb),
  ('Governance', 'wg-governance',
   'brand.json, adagents.json, brand safety, compliance, policy.',
   'governance', 'active', 40, false, '[]'::jsonb),
  ('Builders', 'wg-builders',
   'SDKs, tooling, integration help. Where people implementing agents get support. Not protocol design.',
   'working_group', 'active', 50, false, '[]'::jsonb)
ON CONFLICT (slug) DO NOTHING;
