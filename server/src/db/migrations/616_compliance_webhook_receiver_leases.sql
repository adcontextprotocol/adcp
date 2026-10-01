-- Public webhook callbacks reach web machines, while hosted compliance may
-- run on a private worker. This short-lived lookup routes a run-scoped callback
-- to the SDK receiver bound on that runner's Fly private address. Store only
-- the hash of the bearer route token, never the token advertised to sellers.
CREATE TABLE compliance_webhook_receiver_leases (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  machine_id TEXT NOT NULL CHECK (machine_id ~ '^[0-9a-f]{8,24}$'),
  port INTEGER NOT NULL CHECK (port BETWEEN 18080 AND 18127),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX compliance_webhook_receiver_leases_expires_at_idx
  ON compliance_webhook_receiver_leases (expires_at);
