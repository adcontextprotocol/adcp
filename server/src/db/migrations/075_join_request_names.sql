-- Add name columns to join requests table
-- Captures requester names at request time for display purposes

ALTER TABLE organization_join_requests
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
