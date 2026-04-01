-- seat_type on organization_memberships is now admin intent (seat allocation),
-- not the source of truth for contributor status.
-- Contributor status is derived: user has a mapped Slack account OR
-- is an active member of a working group.
--
-- Change the default to community_only since contributor should be opt-in.

ALTER TABLE organization_memberships
  ALTER COLUMN seat_type SET DEFAULT 'community_only';

ALTER TABLE invitation_seat_types
  ALTER COLUMN seat_type SET DEFAULT 'community_only';
