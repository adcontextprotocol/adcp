-- Backfill bad fan-out attribution from the brief window between #4851
-- (fan-out wired into crawlSingleDomain) and this migration. During that
-- window, when the crawler hit any cafemedia-managed publisher via
-- ads.txt MANAGERDOMAIN, it ran the fan-out using the SOURCE publisher
-- (the delegating child) as the manager_domain — overwriting siblings'
-- manager_domain attribution with whichever child got crawled most
-- recently.
--
-- Result on production: ~6,800 publisher rows had discovery_method =
-- 'adagents_authoritative' but manager_domain pointing at one of their
-- siblings (e.g., 07.gg.manager_domain = '2foodtrippers.com') instead
-- of the actual manager (e.g., cafemedia.com).
--
-- Fix: a row whose manager_domain points to another `adagents_authoritative`
-- row is downstream of a delegation chain. Resolve to the chain's root
-- (the row whose discovery_method is NOT 'adagents_authoritative'). For
-- the cafemedia/Raptive set, that resolves to the actual cafemedia.com
-- row (discovery_method = 'direct').
--
-- This is one-shot data cleanup; the prospective fix in crawler.ts
-- (skip fan-out when validation.discovery_method = 'ads_txt_managerdomain')
-- prevents re-introduction.

BEGIN;

-- Two-step backfill:
--  1. For rows currently attributed to another adagents_authoritative
--     row, find the root manager (the first non-adagents_authoritative
--     ancestor in the chain).
--  2. UPDATE those rows to point at the root.
--
-- Recursive CTE walks the chain (max depth 10 to defend against cycles
-- that shouldn't exist but might if data is more broken than we think).

WITH RECURSIVE
chain AS (
  -- Seed: every child whose manager points at another fan-out child.
  SELECT
    p1.domain AS child_domain,
    p2.domain AS hop_domain,
    p2.manager_domain AS next_manager,
    p2.discovery_method AS hop_discovery_method,
    1 AS depth
  FROM publishers p1
  JOIN publishers p2 ON p2.domain = p1.manager_domain
  WHERE p1.discovery_method = 'adagents_authoritative'
    AND p2.discovery_method = 'adagents_authoritative'

  UNION ALL

  -- Walk: follow the chain until we hit a non-adagents_authoritative row
  -- (the actual manager) or a row with NULL manager_domain.
  SELECT
    c.child_domain,
    p.domain,
    p.manager_domain,
    p.discovery_method,
    c.depth + 1
  FROM chain c
  JOIN publishers p ON p.domain = c.next_manager
  WHERE c.hop_discovery_method = 'adagents_authoritative'
    AND c.depth < 10
),
resolved AS (
  -- The root manager is the deepest hop whose discovery_method is NOT
  -- adagents_authoritative. DISTINCT ON keeps one row per child_domain.
  SELECT DISTINCT ON (child_domain)
    child_domain,
    hop_domain AS root_manager_domain
  FROM chain
  WHERE hop_discovery_method IS NOT NULL
    AND hop_discovery_method != 'adagents_authoritative'
  ORDER BY child_domain, depth DESC
)
UPDATE publishers p
   SET manager_domain = r.root_manager_domain,
       updated_at = NOW()
  FROM resolved r
 WHERE p.domain = r.child_domain
   AND p.manager_domain != r.root_manager_domain;

COMMIT;
