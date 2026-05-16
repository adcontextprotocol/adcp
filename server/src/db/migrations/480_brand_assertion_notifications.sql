-- Rate-limit state for the brand.json mutual-assertion self-healing loop
-- (issue #4527). When a consumer detects a leaf_only edge (leaf claims
-- house_domain: X but X's brand_refs[] is silent), the spec says the
-- consumer SHOULD notify X's contact.email — and MUST rate-limit per
-- {leaf, house} pair to avoid flooding. This table is the durable
-- rate-limit state.
--
-- One row per (leaf_domain, house_domain) pair. Insert/update is a single
-- statement so concurrent notify calls can't both clear the cooldown.

CREATE TABLE IF NOT EXISTS brand_assertion_notifications (
  leaf_domain TEXT NOT NULL,
  house_domain TEXT NOT NULL,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notification_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (leaf_domain, house_domain)
);

-- Per-house index for ops: "which leaves have I been notified about?"
-- Useful when a house team is auditing pending reciprocation requests.
CREATE INDEX IF NOT EXISTS idx_brand_assertion_notifications_house
  ON brand_assertion_notifications (house_domain, last_notified_at DESC);

COMMENT ON TABLE brand_assertion_notifications IS
  'Rate-limit state for brand.json mutual-assertion self-healing notifications. One row per (leaf_domain, house_domain) pair; 24h cooldown enforced in the notify_pending_verification Addie tool. See docs/brand-protocol/brand-json.mdx#self-healing-through-notification.';
