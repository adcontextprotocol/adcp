-- Migration: 214_community_indexes.sql
-- Adds indexes and constraints for community platform data integrity.

-- Prevent duplicate connections between the same pair of users (regardless of direction)
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_pair
  ON connections (LEAST(requester_user_id, recipient_user_id), GREATEST(requester_user_id, recipient_user_id));

-- Prevent duplicate point awards for the same user/action/reference combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_points_dedup
  ON community_points (workos_user_id, action, reference_id)
  WHERE reference_id IS NOT NULL;

-- Composite index for connection status lookups (used in listPeople correlated subquery)
CREATE INDEX IF NOT EXISTS idx_connections_pair_lookup
  ON connections (requester_user_id, recipient_user_id);
