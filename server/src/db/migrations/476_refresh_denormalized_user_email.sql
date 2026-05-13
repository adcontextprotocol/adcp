-- Backfill stale denormalized email on person_relationships and
-- organization_memberships from users.email.
--
-- Why: both tables carry a copy of users.email that the admin UI and member
-- list read directly. The mergeUsers and PUT /primary code paths swap
-- users.email without refreshing these denorms, so promotes and primary-email
-- swaps leave the row showing the old email. The companion code change in
-- this PR adds the refresh to both paths going forward; this migration mops
-- up the rows that already drifted (174 person_relationships, 2
-- organization_memberships at the time of writing).
--
-- Same drift pattern as the FK-less denormalized pointer playbook on
-- users.primary_organization_id (PR #4182 / migration 473): read self-heal,
-- write-path fix, one-shot backfill. There's no FK to add for email — it's
-- a string, not a pointer — but the refresh-on-write keeps it from drifting
-- again.

UPDATE person_relationships pr
   SET email = u.email,
       updated_at = NOW()
  FROM users u
 WHERE pr.workos_user_id = u.workos_user_id
   AND pr.email IS DISTINCT FROM u.email;

UPDATE organization_memberships om
   SET email = u.email,
       updated_at = NOW()
  FROM users u
 WHERE om.workos_user_id = u.workos_user_id
   AND om.email IS DISTINCT FROM u.email;
