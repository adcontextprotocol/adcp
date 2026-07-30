-- Canonicalize agent_context URLs and merge historical URL variants.
--
-- Application canonicalization lowercases the endpoint and removes trailing
-- slashes. Before that invariant was enforced at the DB boundary, a single
-- org could hold both canonical and cosmetic variants because the original
-- unique constraint compares agent_url byte-for-byte. Preserve credentials
-- and test history while collapsing those rows.

CREATE TEMP TABLE agent_context_url_merge ON COMMIT DROP AS
WITH canonicalized AS (
  SELECT
    id AS source_id,
    organization_id,
    lower(rtrim(btrim(agent_url), '/')) AS canonical_url,
    oauth_access_token_encrypted IS NOT NULL
      AND oauth_access_token_iv IS NOT NULL AS has_oauth_access,
    oauth_refresh_token_encrypted IS NOT NULL
      AND oauth_refresh_token_iv IS NOT NULL AS has_oauth_refresh,
    oauth_client_id IS NOT NULL AS has_oauth_client,
    auth_token_encrypted IS NOT NULL
      AND auth_token_iv IS NOT NULL AS has_static_auth,
    oauth_cc_token_endpoint IS NOT NULL
      AND oauth_cc_client_id IS NOT NULL
      AND oauth_cc_client_secret_encrypted IS NOT NULL
      AND oauth_cc_client_secret_iv IS NOT NULL AS has_client_credentials,
    updated_at,
    created_at
  FROM agent_contexts
  WHERE lower(rtrim(btrim(agent_url), '/')) <> ''
), ranked AS (
  SELECT
    *,
    first_value(source_id) OVER (
      PARTITION BY organization_id, canonical_url
      ORDER BY
        has_oauth_refresh DESC,
        has_oauth_access DESC,
        has_oauth_client DESC,
        has_static_auth DESC,
        has_client_credentials DESC,
        updated_at DESC,
        created_at DESC,
        source_id
    ) AS survivor_id
  FROM canonicalized
)
SELECT source_id, survivor_id, organization_id, canonical_url
FROM ranked;

-- Keep each encrypted value and its IV from the same row. Prefer a refreshable
-- OAuth grant over a newer access-only grant because it remains renewable.
WITH oauth_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id,
    source.oauth_access_token_encrypted,
    source.oauth_access_token_iv,
    source.oauth_refresh_token_encrypted,
    source.oauth_refresh_token_iv,
    source.oauth_token_expires_at
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.oauth_access_token_encrypted IS NOT NULL
    AND source.oauth_access_token_iv IS NOT NULL
  ORDER BY
    m.survivor_id,
    (source.oauth_refresh_token_encrypted IS NOT NULL
      AND source.oauth_refresh_token_iv IS NOT NULL) DESC,
    source.updated_at DESC,
    source.id
)
UPDATE agent_contexts target
SET oauth_access_token_encrypted = source.oauth_access_token_encrypted,
    oauth_access_token_iv = source.oauth_access_token_iv,
    oauth_refresh_token_encrypted = source.oauth_refresh_token_encrypted,
    oauth_refresh_token_iv = source.oauth_refresh_token_iv,
    oauth_token_expires_at = source.oauth_token_expires_at
FROM oauth_source source
WHERE target.id = source.survivor_id;

WITH oauth_client_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id,
    source.oauth_client_id,
    source.oauth_client_secret_encrypted,
    source.oauth_client_secret_iv,
    source.oauth_registered_redirect_uri
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.oauth_client_id IS NOT NULL
  ORDER BY m.survivor_id, source.updated_at DESC, source.id
)
UPDATE agent_contexts target
SET oauth_client_id = source.oauth_client_id,
    oauth_client_secret_encrypted = source.oauth_client_secret_encrypted,
    oauth_client_secret_iv = source.oauth_client_secret_iv,
    oauth_registered_redirect_uri = source.oauth_registered_redirect_uri
FROM oauth_client_source source
WHERE target.id = source.survivor_id;

WITH static_auth_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id,
    source.auth_token_encrypted,
    source.auth_token_iv,
    source.auth_token_hint,
    source.auth_type
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.auth_token_encrypted IS NOT NULL
    AND source.auth_token_iv IS NOT NULL
  ORDER BY m.survivor_id, source.updated_at DESC, source.id
)
UPDATE agent_contexts target
SET auth_token_encrypted = source.auth_token_encrypted,
    auth_token_iv = source.auth_token_iv,
    auth_token_hint = source.auth_token_hint,
    auth_type = source.auth_type
FROM static_auth_source source
WHERE target.id = source.survivor_id;

WITH client_credentials_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id,
    source.oauth_cc_token_endpoint,
    source.oauth_cc_client_id,
    source.oauth_cc_client_secret_encrypted,
    source.oauth_cc_client_secret_iv,
    source.oauth_cc_scope,
    source.oauth_cc_resource,
    source.oauth_cc_audience,
    source.oauth_cc_auth_method
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.oauth_cc_token_endpoint IS NOT NULL
    AND source.oauth_cc_client_id IS NOT NULL
    AND source.oauth_cc_client_secret_encrypted IS NOT NULL
    AND source.oauth_cc_client_secret_iv IS NOT NULL
  ORDER BY m.survivor_id, source.updated_at DESC, source.id
)
UPDATE agent_contexts target
SET oauth_cc_token_endpoint = source.oauth_cc_token_endpoint,
    oauth_cc_client_id = source.oauth_cc_client_id,
    oauth_cc_client_secret_encrypted = source.oauth_cc_client_secret_encrypted,
    oauth_cc_client_secret_iv = source.oauth_cc_client_secret_iv,
    oauth_cc_scope = source.oauth_cc_scope,
    oauth_cc_resource = source.oauth_cc_resource,
    oauth_cc_audience = source.oauth_cc_audience,
    oauth_cc_auth_method = source.oauth_cc_auth_method
FROM client_credentials_source source
WHERE target.id = source.survivor_id;

-- Preserve all detailed run history before removing duplicate parents.
UPDATE agent_test_history history
SET agent_context_id = m.survivor_id
FROM agent_context_url_merge m
WHERE history.agent_context_id = m.source_id
  AND m.source_id <> m.survivor_id;

-- Carry forward useful non-secret state from any cosmetic duplicate.
WITH merged_state AS (
  SELECT
    m.survivor_id,
    max(source.last_discovered_at) AS last_discovered_at,
    min(source.created_at) AS created_at,
    max(source.updated_at) AS updated_at,
    coalesce(sum(source.total_tests_run), 0)::integer AS total_tests_run
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  GROUP BY m.survivor_id
)
UPDATE agent_contexts target
SET last_discovered_at = coalesce(state.last_discovered_at, target.last_discovered_at),
    created_at = state.created_at,
    updated_at = state.updated_at,
    total_tests_run = state.total_tests_run
FROM merged_state state
WHERE target.id = state.survivor_id;

WITH name_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id, source.agent_name
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.agent_name IS NOT NULL
  ORDER BY m.survivor_id, source.updated_at DESC, source.id
)
UPDATE agent_contexts target
SET agent_name = coalesce(target.agent_name, source.agent_name)
FROM name_source source
WHERE target.id = source.survivor_id;

WITH tools_source AS (
  SELECT DISTINCT ON (m.survivor_id)
    m.survivor_id, source.tools_discovered
  FROM agent_context_url_merge m
  JOIN agent_contexts source ON source.id = m.source_id
  WHERE source.tools_discovered IS NOT NULL
  ORDER BY m.survivor_id, source.last_discovered_at DESC NULLS LAST, source.id
)
UPDATE agent_contexts target
SET tools_discovered = coalesce(target.tools_discovered, source.tools_discovered)
FROM tools_source source
WHERE target.id = source.survivor_id;

DELETE FROM agent_contexts duplicate
USING agent_context_url_merge m
WHERE duplicate.id = m.source_id
  AND m.source_id <> m.survivor_id;

-- The exact unique constraint is now sufficient because all write paths and
-- existing rows share the same canonical representation.
UPDATE agent_contexts context
SET agent_url = m.canonical_url
FROM agent_context_url_merge m
WHERE context.id = m.survivor_id
  AND context.agent_url IS DISTINCT FROM m.canonical_url;
