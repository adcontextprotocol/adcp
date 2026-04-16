---
"adcontextprotocol": minor
---

TMP signing and key lifecycle hardening, plus Prebid proposal updates. Addresses feedback on RFC #2203.

**Protocol changes:**

- Add `provider_endpoint_url` to Context Match and Identity Match signed fields. Signatures now bind to a specific provider; a captured signature cannot be replayed against other providers in the registry within the epoch. Signature caches key on `(placement_id, provider_endpoint_url)`, not `placement_id` alone.
- Add optional `revoked_at` field to `agent-signing-key.json`. Verifiers MUST reject signatures produced with a revoked key whose signing epoch is at or after the revocation timestamp. Keys stay in the trust anchor during a grace period so stale caches still find the revocation marker.

**Proposal doc updates (`specs/prebid-tmp-proposal.md`):**

- Temporal decorrelation reframed as a publisher-chosen profile combining volume, batching, cross-page caching, and explicit delay — not a fixed 100-2000ms delay mandate. Delay applies to Identity Match only (Context Match is on the auction critical path).
- Request signing section updated to reflect per-provider signatures and explicit revocation.
- Operator guidance covers signing-key storage (HSM/KMS), end-to-end verification before go-live, 401 handling, and `processed-auction-request` hook placement for PBS embeds.
