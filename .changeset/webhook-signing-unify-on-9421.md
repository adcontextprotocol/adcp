---
"adcontextprotocol": minor
---

Unify webhook signing on the AdCP RFC 9421 profile.

Webhooks are now signed under a symmetric variant of the existing request-signing profile: the seller signs outbound with an `adcp_use: "webhook-signing"` key published at the `jwks_uri` on its own brand.json `agents[]` entry (the same publication pattern as any other AdCP agent key), and the buyer verifies against that JWKS. No shared secret crosses the wire; `push_notification_config.authentication` is no longer required.

- `push-notification-config.json` schema: `authentication` moved from required to optional. Description rewritten to point at the 9421 profile as the default and flag `authentication` as the legacy fallback removed in 4.0.
- `security.mdx`: added a "Webhook callbacks" subsection under the 9421 profile with a fully-enumerated 14-step verifier checklist (webhook_signature_* error codes), trust-anchor/blast-radius paragraph, downgrade-and-injection-resistance rules for the unsigned-request case, webhook-specific replay dedup sizing (per-keyid cap 100K, aggregate cap 10M), and HMAC→9421 migration rotation rules. Removed the "webhooks are out of scope for this profile" carve-outs. Added `"webhook-signing"` to the `adcp_use` discriminator table. Rewrote the "Webhook Security" section so 9421 is the baseline and HMAC-SHA256 is the deprecated fallback.
- `webhooks.mdx`: made 9421 the primary "Signature verification" section; demoted HMAC-SHA256 and Bearer to "Legacy fallback (deprecated)" subsections with a removal-in-4.0 warning. Dropped `authentication` from default MCP and A2A examples. Updated dedup scope language to cover both 9421 keyid-based identity and legacy HMAC/Bearer identity, with a note on cross-scheme dedup during migration.
- `acquire_rights.mdx` and `collection_lists.mdx`: updated webhook-signing references from "HMAC-SHA256 only" to point at the unified profile with 9421 as default.
- `webhook-hmac-sha256.json` test vectors: marked as legacy with a `status: "legacy"` field and deprecation note. 9421 webhook conformance vectors will ship alongside the existing request-signing vectors in a follow-up.

Baseline-required in 3.0 (no capability advertisement — sellers that emit webhooks MUST sign); HMAC fallback available through 3.x when buyers opt in via `authentication.credentials`; `authentication` removed from the schema in 4.0.
