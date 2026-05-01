-- Backfill member_profiles.agents[].type from agent_capabilities_snapshot.inferred_type.
-- Replaces server/scripts/backfill-member-agent-types.ts (#3541).
--
-- Why a migration instead of a script: the script lived under server/scripts/
-- (outside server/src/), so tsc skipped it and the .ts never shipped to the
-- production container. A migration runs automatically on the next deploy in
-- every env, atomically with the audit-log inserts.
--
-- Logic mirrors resolveAgentTypes() in server/src/routes/member-profiles.ts:
--   - snapshot exists with valid inferred_type → use it
--   - snapshot exists, no/invalid inferred_type → 'unknown' (anti type-smuggling)
--   - no snapshot → leave the agent untouched
--
-- Audit rows go to type_reclassification_log with source='backfill_script' and
-- run_id='migration-463'. To see every flip this migration produced:
--   SELECT * FROM type_reclassification_log WHERE run_id = 'migration-463';
--
-- Refs #3538, #3541, #3550.

-- Step 1: log every pending flip BEFORE mutating member_profiles.
WITH candidates AS (
  SELECT
    mp.id        AS member_id,
    elem->>'url' AS agent_url,
    COALESCE(elem->>'type', 'unknown') AS old_type,
    CASE
      WHEN s.inferred_type IN (
        'brand','rights','measurement','governance','creative',
        'sales','buying','signals','unknown'
      ) THEN s.inferred_type
      ELSE 'unknown'
    END AS new_type
  FROM member_profiles mp,
       jsonb_array_elements(mp.agents) elem
  LEFT JOIN agent_capabilities_snapshot s
    ON s.agent_url = elem->>'url'
  WHERE mp.agents IS NOT NULL
    AND jsonb_typeof(mp.agents) = 'array'
    AND s.agent_url IS NOT NULL
)
INSERT INTO type_reclassification_log
  (agent_url, member_id, old_type, new_type, source, run_id, notes)
SELECT
  agent_url, member_id, old_type, new_type,
  'backfill_script', 'migration-463',
  jsonb_build_object('migration', '463_backfill_member_agent_types_from_snapshot')
FROM candidates
WHERE old_type IS DISTINCT FROM new_type;

-- Step 2: rewrite member_profiles.agents in place. Same CASE as Step 1; the
-- `EXISTS` guard skips rewriting profiles with no snapshotted agents (no-op).
UPDATE member_profiles mp
SET agents = (
  SELECT jsonb_agg(
    CASE
      WHEN s.agent_url IS NOT NULL THEN
        jsonb_set(
          elem,
          '{type}',
          to_jsonb(
            CASE
              WHEN s.inferred_type IN (
                'brand','rights','measurement','governance','creative',
                'sales','buying','signals','unknown'
              ) THEN s.inferred_type
              ELSE 'unknown'
            END
          )
        )
      ELSE elem
    END
  )
  FROM jsonb_array_elements(mp.agents) elem
  LEFT JOIN agent_capabilities_snapshot s ON s.agent_url = elem->>'url'
)
WHERE mp.agents IS NOT NULL
  AND jsonb_typeof(mp.agents) = 'array'
  AND jsonb_array_length(mp.agents) > 0
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(mp.agents) elem
    JOIN agent_capabilities_snapshot s ON s.agent_url = elem->>'url'
  );
