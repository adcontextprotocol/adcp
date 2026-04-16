-- Correct the consolidation approach in migration 405.
--
-- Migration 405 created five new parallel working groups with fresh slugs
-- (wg-campaign-lifecycle, wg-creative, wg-signals-measurement, wg-governance,
-- wg-builders). That left two parallel structures: the original WGs seeded
-- long ago (creative-wg, signals-data-wg, media-buying-protocol-wg,
-- brand-standards-wg, events-thought-leadership-wg) and the new duplicates.
--
-- This migration consolidates onto the existing slugs to preserve URLs,
-- members, documents, meetings, and history. It:
--   1. Reparents any subgroups that point at a duplicate parent over to
--      the corresponding existing WG.
--   2. Deletes the four duplicate parents (wg-builders is legitimately new
--      and is kept).
--   3. Renames existing WGs to the new display names.
--
-- Idempotent: safe to re-run. Uses slug lookups throughout.

-- 1. Reparent subgroups from duplicate parents to the existing WG equivalents.
UPDATE working_groups
SET parent_id = (SELECT id FROM working_groups WHERE slug = 'media-buying-protocol-wg')
WHERE parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-campaign-lifecycle');

UPDATE working_groups
SET parent_id = (SELECT id FROM working_groups WHERE slug = 'creative-wg')
WHERE parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-creative');

UPDATE working_groups
SET parent_id = (SELECT id FROM working_groups WHERE slug = 'signals-data-wg')
WHERE parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-signals-measurement');

UPDATE working_groups
SET parent_id = (SELECT id FROM working_groups WHERE slug = 'brand-standards-wg')
WHERE parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-governance');

-- 2. Delete the four duplicate parents created in migration 405.
-- (wg-builders stays — it's a new concept with no existing equivalent.)
DELETE FROM working_groups
WHERE slug IN ('wg-campaign-lifecycle', 'wg-creative', 'wg-signals-measurement', 'wg-governance');

-- 3. Rename existing WGs to the new display names and set display_order.
UPDATE working_groups SET
  name = 'Campaign Lifecycle',
  description = 'Discovery, proposals, execution, trafficking, pacing, makegoods, reconciliation. The full arc from finding inventory through reconciling the buy.',
  display_order = 10
WHERE slug = 'media-buying-protocol-wg';

UPDATE working_groups SET
  name = 'Creative',
  description = 'Creative lifecycle, generative creative, governance, and audit.',
  display_order = 20
WHERE slug = 'creative-wg';

UPDATE working_groups SET
  name = 'Signals and Measurement',
  description = 'Audience signals, measurement, verification, attribution.',
  display_order = 30
WHERE slug = 'signals-data-wg';

UPDATE working_groups SET
  name = 'Governance',
  description = 'brand.json, adagents.json, brand safety, compliance, policy.',
  committee_type = 'governance',
  display_order = 40
WHERE slug = 'brand-standards-wg';

UPDATE working_groups SET
  name = 'Community & Events',
  description = 'Community building, events, thought leadership, marketing, and training programs.',
  display_order = 60
WHERE slug = 'events-thought-leadership-wg';

-- 4. Attach #salesagent-dev as the Slack channel for Builders. Channel will be
-- renamed to #builders separately; ID stays stable across a Slack rename.
UPDATE working_groups SET slack_channel_id = 'C09J28K9K29'
WHERE slug = 'wg-builders' AND slack_channel_id IS NULL;
