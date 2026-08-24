-- Surface relationship trust state on the brands index row so list endpoints
-- can return it without a per-row resolveBrand() call at query time.
-- Populated by the crawler after each brand.json resolution cycle.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS relationship_trust TEXT,
  ADD COLUMN IF NOT EXISTS relationship_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_house_domain TEXT,
  ADD COLUMN IF NOT EXISTS relationship_trust_computed_at TIMESTAMPTZ;

COMMENT ON COLUMN brands.relationship_trust IS
  'Cached trust verdict from the last crawler resolution: inline | mutual | leaf_only | house_only | standalone | unverifiable. NULL means not yet computed, not standalone.';

COMMENT ON COLUMN brands.relationship_verified_at IS
  'When the mutual-assertion edge was last confirmed by both sides. Only set when relationship_trust = ''mutual''.';

COMMENT ON COLUMN brands.claimed_house_domain IS
  'Unilateral parent claim from the brand''s own document. Not trust-extending. Populated for leaf_only and unverifiable.';

COMMENT ON COLUMN brands.relationship_trust_computed_at IS
  'Timestamp of the last crawler pass that computed relationship_trust. Allows freshness checks without joining brand_relationship_declarations.';
