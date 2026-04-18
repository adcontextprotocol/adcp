-- Rename the brand-safety standard from a vendor-branded identifier
-- ('scope3_brand_safety') to the neutral framework name 'csbs'
-- (Common Sense Brand Standards). The framework was contributed to
-- AgenticAdvertising.org; the renamed identifier reflects AAO governance.
--
-- policy_revisions.policy_id is an FK to policies.policy_id with no
-- ON UPDATE CASCADE, so the FK is temporarily dropped, both tables are
-- updated, and the FK is restored.

ALTER TABLE policy_revisions
  DROP CONSTRAINT IF EXISTS policy_revisions_policy_id_fkey;

UPDATE policies
SET policy_id = 'csbs',
    name = 'Common Sense Brand Standards',
    description = 'Common Sense Brand Standards (CSBS) — content adjacency standard governed by AgenticAdvertising.org.',
    source_name = 'AgenticAdvertising.org',
    updated_at = NOW()
WHERE policy_id = 'scope3_brand_safety';

UPDATE policy_revisions
SET policy_id = 'csbs'
WHERE policy_id = 'scope3_brand_safety';

ALTER TABLE policy_revisions
  ADD CONSTRAINT policy_revisions_policy_id_fkey
  FOREIGN KEY (policy_id) REFERENCES policies(policy_id) ON UPDATE CASCADE;
