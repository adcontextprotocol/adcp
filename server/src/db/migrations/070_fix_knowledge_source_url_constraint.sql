-- Migration: 070_fix_knowledge_source_url_constraint.sql
-- Fix ON CONFLICT issue: PostgreSQL cannot use partial indexes for ON CONFLICT (column).
-- Replace the partial unique index with a non-partial unique constraint.

-- First, drop the partial index that doesn't work with ON CONFLICT
DROP INDEX IF EXISTS idx_addie_knowledge_source_url_unique;

-- Remove any duplicate source_urls keeping the most recent entry
-- This is needed before adding the unique constraint
DELETE FROM addie_knowledge a
USING addie_knowledge b
WHERE a.source_url = b.source_url
  AND a.source_url IS NOT NULL
  AND a.id < b.id;

-- Create a proper unique constraint that works with ON CONFLICT (source_url)
-- PostgreSQL allows multiple NULLs in unique constraints by default
ALTER TABLE addie_knowledge
  ADD CONSTRAINT addie_knowledge_source_url_unique UNIQUE (source_url);
