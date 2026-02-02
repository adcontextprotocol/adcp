-- Migration: 191_member_profiles_brands.sql
-- Purpose: Add brands array to member_profiles for brand ownership
-- Enables members to claim/manage brands alongside their agent configurations

-- Add brands column to member_profiles
-- Stores array of brand canonical domains this member owns
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '[]'::jsonb;

-- Index for brand lookups
-- Enables queries like "which member owns nike.com?"
CREATE INDEX IF NOT EXISTS idx_member_profiles_brands ON member_profiles USING GIN(brands);
