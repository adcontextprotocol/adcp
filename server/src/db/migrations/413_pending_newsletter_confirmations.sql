-- Pending newsletter confirmations.
--
-- Decouples the "prove you own this inbox" step from WorkOS user creation.
-- POST /api/newsletter/subscribe writes here; GET /newsletter/confirm reads
-- the token, then provisions the WorkOS user and flips marketing_opt_in.
-- Keyed by email so a second subscribe from the same inbox within the
-- cooldown window finds the prior row without leaking across emails.

CREATE TABLE IF NOT EXISTS pending_newsletter_confirmations (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_newsletter_confirmations_token
  ON pending_newsletter_confirmations (token);

COMMENT ON TABLE pending_newsletter_confirmations IS
  'Unconfirmed newsletter subscriptions. No WorkOS user exists yet — that happens on confirm click.';
