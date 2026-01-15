-- Migration: 169_remove_rss_from_editorial.sql
-- Fix: Remove RSS-sourced content from Editorial working group
--
-- Migration 153 incorrectly swept ALL perspectives with NULL working_group_id
-- into the Editorial working group, including RSS feed articles.
-- RSS content should remain unassigned (working_group_id = NULL) and display
-- via The Latest sections through addie_knowledge, not on working group pages.

-- =============================================================================
-- Remove RSS and email content from any working group
-- =============================================================================

UPDATE perspectives
SET working_group_id = NULL
WHERE source_type IN ('rss', 'email')
  AND working_group_id IS NOT NULL;

-- =============================================================================
-- Done
-- =============================================================================
