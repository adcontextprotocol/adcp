-- Persisted authorization epoch (#6827).
--
-- Identity-binding changes previously revoked stale authority by evicting the
-- in-process session cache (`invalidateSessionsForUsers`). That is not a
-- revocation mechanism: the server runs multiple instances, so a binding
-- change on instance A leaves instance B serving its cached pre-change
-- id-swap and organization context until the TTL elapses. Long-lived
-- surfaces (Slack bolt, MCP sessions) hold context longer still.
--
-- One monotonic counter per WorkOS credential, bumped in the same transaction
-- as the binding mutation. Sessions stamp the value they observed and
-- revalidate it on every cache hit, so authority granted before the change
-- cannot outlive it on any instance.
--
-- No backfill: an absent row reads as epoch 0. The first bump inserts at 1,
-- which differs from the 0 a pre-change session stamped, so the comparison
-- still invalidates. A CASCADE delete (WorkOS user.deleted) removes the row
-- and returns the credential to "absent", which likewise differs from any
-- stamped value — callers compare for inequality, never for "greater than".

CREATE TABLE IF NOT EXISTS authorization_epochs (
  workos_user_id VARCHAR(255) PRIMARY KEY
    REFERENCES users(workos_user_id) ON DELETE CASCADE,
  epoch BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE authorization_epochs IS
  'Monotonic per-credential authorization version; bumped transactionally with identity-binding changes so stale sessions lose pre-change authority on every instance';
