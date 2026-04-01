-- Migration: 339_drop_dead_scoring_functions.sql
-- Drop dead engagement scoring SQL functions. The old scoring system
-- has been replaced by community_points.

DROP FUNCTION IF EXISTS compute_user_engagement_score(VARCHAR);
DROP FUNCTION IF EXISTS compute_user_excitement_score(VARCHAR);
DROP FUNCTION IF EXISTS compute_slack_user_engagement_score(VARCHAR);
DROP FUNCTION IF EXISTS update_user_scores(VARCHAR);
DROP FUNCTION IF EXISTS update_stale_user_scores(INTEGER);
DROP FUNCTION IF EXISTS compute_org_engagement_score(VARCHAR);
DROP FUNCTION IF EXISTS update_org_engagement(VARCHAR);
DROP FUNCTION IF EXISTS update_stale_org_engagement_scores(INTEGER);
