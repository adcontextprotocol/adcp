-- Migration: three-tier agent visibility
--
-- Replaces the boolean `is_public` flag on each agent entry in
-- member_profiles.agents (a JSONB array) with a three-valued enum:
--
--   'private'       → owner-only
--   'members_only'  → visible to members with API access (Professional+)
--   'public'        → listed in the public directory / brand.json
--
-- Existing data: is_public = true  → visibility = 'public'
--                is_public = false → visibility = 'private'
--
-- The old key is dropped so the JSON shape matches the new AgentConfig
-- TypeScript type exactly. The deserializer still tolerates legacy rows
-- (belt-and-braces) in case a row slips through between deploy and
-- migration application.

-- The pre-migration schema only knew `is_public`. We deliberately do NOT
-- trust any pre-existing `visibility` key: that field shouldn't exist
-- yet, and trusting it would let an attacker who slipped
-- `visibility: 'public'` into the JSONB via a less-strict path pre-
-- migration retain that value. Always recompute from `is_public`.

UPDATE member_profiles
SET agents = COALESCE(
  (
    SELECT jsonb_agg(
      (
        (elem - 'is_public' - 'visibility')
        || jsonb_build_object(
          'visibility',
          CASE
            WHEN (elem->>'is_public')::boolean IS TRUE THEN 'public'
            ELSE 'private'
          END
        )
      )
    )
    FROM jsonb_array_elements(agents) AS elem
  ),
  '[]'::jsonb
)
WHERE agents IS NOT NULL
  AND jsonb_typeof(agents) = 'array'
  AND jsonb_array_length(agents) > 0;
