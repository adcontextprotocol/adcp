-- @adcp/sdk 17's PostgresReplayStore inserts through a guarded function, so
-- the replay check, the per-(keyid, scope) cap and the insert run on one
-- backend under a transaction-scoped advisory lock (safe behind a query-only
-- pool or PgBouncer). Without it every insert fails with "PostgresReplayStore
-- database migration is outdated", which surfaces as a 503 on the training
-- agent's signed routes (the RFC 9421 strict routes and the 3.3 identity
-- route).
--
-- Generated from getReplayStoreMigration('adcp_replay_cache') in
-- @adcp/sdk 17.0.0-beta.0. The table and indexes are unchanged from
-- 447_adcp_replay_cache.sql; only the function is new. CREATE OR REPLACE
-- keeps this idempotent.
CREATE OR REPLACE FUNCTION adcp_replay_cache_insert_guarded(
  p_keyid TEXT,
  p_scope TEXT,
  p_nonce TEXT,
  p_now DOUBLE PRECISION,
  p_expires_at DOUBLE PRECISION,
  p_cap BIGINT
) RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $adcp_replay_guard$
DECLARE
  active_count BIGINT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION
      'adcp replay insertion requires READ COMMITTED transaction isolation'
      USING ERRCODE = 'AD001';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(jsonb_build_array(p_keyid, p_scope)::text, 0)
  ) THEN
    RETURN 'lock_busy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM adcp_replay_cache
    WHERE keyid = p_keyid
      AND scope = p_scope
      AND nonce = p_nonce
      AND expires_at > to_timestamp(p_now)
  ) THEN
    RETURN 'replayed';
  END IF;

  SELECT count(*) INTO active_count
  FROM adcp_replay_cache
  WHERE keyid = p_keyid
    AND scope = p_scope
    AND expires_at > to_timestamp(p_now);

  IF active_count >= p_cap THEN
    RETURN 'rate_abuse';
  END IF;

  INSERT INTO adcp_replay_cache (keyid, scope, nonce, expires_at)
  VALUES (p_keyid, p_scope, p_nonce, to_timestamp(p_expires_at))
  ON CONFLICT (keyid, scope, nonce) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
    WHERE adcp_replay_cache.expires_at <= to_timestamp(p_now);

  IF FOUND THEN
    RETURN 'ok';
  END IF;
  RETURN 'replayed';
END
$adcp_replay_guard$;
  
