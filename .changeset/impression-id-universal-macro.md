---
"adcontextprotocol": minor
---

Add `IMPRESSION_ID` universal macro for impression-level deduplication

A general-purpose per-impression identifier macro that buyers, measurement vendors, verification services, and TMP can use for per-impression dedup, cross-vendor reconciliation, pixel-retry detection, and (in TMP) cross-identity exposure dedup. Closes the gap where TMP context-only impressions had no impression_id available (no `{TMPX}` → no buyer-side decode-time mint).

Format is implementation choice — UUID, ULID, snowflake, or any collision-resistant scheme. Three-layer minting hierarchy: (1) publisher first-party code, (2) ad-decision layer (Prebid TMP module, ad server, SSP), (3) buyer impression tracker at `{TMPX}` decode (TMP-specific fallback). Each lower layer MUST defer to whatever an upstream layer already minted.

Documents the Prebid TMP module pattern using the `tmp_impression_id` GAM targeting key and the optional reuse of `adUnit.transactionId` when Prebid's `enableTIDs` config is on. No router changes; preserves TMP's identity↔context structural separation by keeping minting at the publisher/decision-layer join.
