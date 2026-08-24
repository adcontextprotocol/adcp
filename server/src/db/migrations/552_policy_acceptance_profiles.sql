-- Preserve machine-readable issuer identity and structured acceptance profiles
-- on authoritative policy-registry records. Community policy authoring does not
-- populate these fields; registry publication is the controlled write path.

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS issuer JSONB,
  ADD COLUMN IF NOT EXISTS acceptance_profile JSONB;

ALTER TABLE policies
  ADD CONSTRAINT policies_issuer_object_check
    CHECK (issuer IS NULL OR jsonb_typeof(issuer) = 'object'),
  ADD CONSTRAINT policies_acceptance_profile_object_check
    CHECK (acceptance_profile IS NULL OR jsonb_typeof(acceptance_profile) = 'object');

-- Preserve every authoritative registry publication as an immutable,
-- resolver-verifiable snapshot. The digest covers canonical_content after RFC
-- 8785 (JCS) serialization; acceptance_profile is stored separately because it
-- carries its own digest and may pin this policy snapshot.
CREATE TABLE policy_publications (
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  canonical_content JSONB NOT NULL CHECK (jsonb_typeof(canonical_content) = 'object'),
  acceptance_profile JSONB CHECK (acceptance_profile IS NULL OR jsonb_typeof(acceptance_profile) = 'object'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_id, version)
);

CREATE OR REPLACE FUNCTION reject_policy_publication_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'policy_publications rows are immutable; publish a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policy_publications_immutable
  BEFORE UPDATE OR DELETE ON policy_publications
  FOR EACH ROW EXECUTE FUNCTION reject_policy_publication_mutation();
