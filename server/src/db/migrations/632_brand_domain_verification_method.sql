-- Record how a brand row's domain_verified flag was established, so the flag
-- means proof of control rather than an administrator's assertion (#8768).
--
-- Existing verified rows keep their flag with a NULL method. Routine WorkOS
-- syncs leave them alone; scripts/reclassify-brand-domain-verification.ts
-- classifies them (dry-run first). Every write path sets the method from this
-- migration on.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS domain_verification_method TEXT
    CHECK (domain_verification_method IN ('dns', 'brand_json', 'member_email', 'manual'));

COMMENT ON COLUMN brands.domain_verification_method IS
  'How the owning organization''s claim to the domain was established: dns (WorkOS DNS verification), brand_json (the domain''s /.well-known/brand.json points at the AAO-hosted record), member_email (a WorkOS manual domain with an organization member whose email is on the domain), or manual (a WorkOS manual domain with no other evidence, which leaves domain_verified false). NULL on rows verified before the method was recorded.';
