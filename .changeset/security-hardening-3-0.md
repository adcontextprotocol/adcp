---
"adcontextprotocol": patch
---

Clarify 3.0 security requirements before partners run these flows in production.

- **SSRF (canonical rules in `security.mdx`).** Consolidated list of reserved IPv4 and IPv6 ranges (RFC 1918, RFC 6598 CGNAT, loopback, `169.254.0.0/16` with cloud metadata called out, `::ffff:0:0/96` IPv4-mapped IPv6, multicast). DNS-based filtering alone is insufficient — fetchers MUST pin the TCP connection to the validated IP or re-validate the post-handshake peer address. No redirect following on counterparty-controlled URLs.
- **Webhook signatures.** The signed `{unix_timestamp}` MUST be the exact ASCII integer in `X-ADCP-Timestamp`; signers and verifiers MUST NOT derive it from any body field. Header format and body-field precedence spelled out explicitly.
- **Offline reporting buckets (`#2223`).** IAM-layer prefix scoping (not obscurity), scoped `ListBucket` (not just `GetObject`) to prevent cross-tenant prefix enumeration, revocation tied to `account.status` transitions, `setup_instructions` marked as operator-facing with MUST NOT auto-fetch and indirect-prompt-injection guidance.
- **Collection lists (`#2225`).** `auth_token` scope, per-seller issuance (MUST), log hygiene, webhook URL SSRF via canonical rules, normative HMAC-SHA256 signatures, distribution-ID format validation and rate limits. Compromise-driven revocation requires cache invalidation, not just TTL expiry.
- **Managed network `authoritative_location` (`#2224`).** Validator fetch semantics (HTTPS only, no redirects, size and timeout caps), 24-hour cached fallback on 5xx with a 7-day absolute cap measured from the most recent successful fetch, non-monotonic `last_updated` treated as an invalid response to block rollback attacks, concrete change-detection thresholds, relationship-termination handling.
- **TMP provider registration (`#2226`).** SSRF via canonical rules with connection pinning, dynamic-registration caller authentication, router-to-provider auth minimum bar, and `/health` info-leakage rules (no subsystem-specific status codes or response bodies).
