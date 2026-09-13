-- Durable intent and reconciliation evidence for admin WorkOS credential binds.
-- Deliberately no foreign keys: support evidence must survive user/identity deletion.
-- Migration numbers 588-592 are reserved for other work, including member email
-- mutation. The live application ledger was audited before assigning 593.

CREATE TABLE IF NOT EXISTS admin_credential_bind_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_hash TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    host_identity_id UUID NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_identity_id UUID NOT NULL,
    provider_user_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'creating',
        'provider_created',
        'committed',
        'compensating',
        'compensated',
        'provider_rejected',
        'reconciliation_required'
    )),
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_credential_bind_operations_active_email
    ON admin_credential_bind_operations(email_hash)
    WHERE status NOT IN ('compensated', 'provider_rejected');

CREATE INDEX IF NOT EXISTS admin_credential_bind_operations_host_created
    ON admin_credential_bind_operations(host_user_id, created_at DESC);

COMMENT ON TABLE admin_credential_bind_operations IS
    'Admin WorkOS bind intent and reconciliation evidence. Unresolved operations block replay; no credentials, tokens, email addresses, or provider bodies.';

COMMENT ON COLUMN admin_credential_bind_operations.actor_user_id IS
    'The exact WorkOS credential that authenticated the admin, before canonical identity resolution.';
