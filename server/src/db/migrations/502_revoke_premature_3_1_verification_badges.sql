-- Roll back premature public AdCP 3.1 badge issuance.
--
-- The public compliance default is 3.0 while 3.1 remains beta/diagnostic.
-- Any active/degraded 3.1 rows were minted during the accidental default flip
-- and would otherwise keep winning highest-version badge reads.

UPDATE agent_verification_badges
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, NOW()),
    revocation_reason = 'AdCP 3.1 public badge issuance is paused until GA',
    updated_at = NOW()
WHERE adcp_version = '3.1'
  AND status IN ('active', 'degraded');
