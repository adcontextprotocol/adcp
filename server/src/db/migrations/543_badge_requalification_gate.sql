-- Keep badge state hidden after compliance monitoring is re-enabled until a
-- fresh full-suite run has rebuilt every qualifying verdict.
ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS badge_requalification_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS badge_requalification_generation BIGINT NOT NULL DEFAULT 0;

-- Existing opt-outs predate the gate. Preserve their closed state and make
-- any previously suppressed badge revocation durable during rollout.
UPDATE agent_registry_metadata
SET badge_requalification_required = TRUE,
    badge_requalification_generation = GREATEST(badge_requalification_generation, 1)
WHERE compliance_opt_out = TRUE;

WITH revoked AS (
  UPDATE agent_verification_badges b
  SET status = 'revoked',
      revoked_at = NOW(),
      revocation_reason = 'Compliance monitoring opted out',
      updated_at = NOW()
  FROM agent_registry_metadata m
  WHERE b.agent_url = m.agent_url
    AND m.compliance_opt_out = TRUE
    AND b.status IN ('active', 'degraded')
  RETURNING b.agent_url, b.role, b.adcp_version,
            m.badge_requalification_generation
)
INSERT INTO catalog_events (
  event_id, event_type, entity_type, entity_id, payload, actor
)
SELECT
  uuidv7(),
  'agent.verification_lost',
  'agent',
  agent_url,
  jsonb_build_object(
    'agent_url', agent_url,
    'role', role,
    'adcp_version', adcp_version,
    'reason', 'Compliance monitoring opted out',
    'badge_requalification_generation', badge_requalification_generation::text
  ),
  'migration:543_badge_requalification_gate'
FROM revoked r
WHERE EXISTS (
  SELECT 1
  FROM member_profiles mp
  CROSS JOIN LATERAL jsonb_array_elements(mp.agents) agent
  WHERE agent->>'url' = r.agent_url
    AND agent->>'visibility' = 'public'
);
