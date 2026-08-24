---
"adcontextprotocol": minor
---

Define governance enforcement as a cross-role core capability. Consequential request schemas now declare `x-governed-commitment`, while `adcp.governance_enforcement` advertises the enforcement modes and covered tasks.

Tighten the experimental authorization boundary: buyer intent checks use `plan_id`, approved decisions alone issue `governance_context`, downstream services treat that context as the opaque plan binding, and media-buy online execution enforcement follows prepare → check → commit. `conditions` is now an intent-only counterproposal with a separate non-authorizing consultation handle.

Harden governance identity and accounting at the same boundary. Authenticated buyer identity controls delegations across the full lifecycle, while the intent's target audience controls seller authorization. Purchase checks may run before a durable media-buy ID exists, must authenticate as that audience, and may narrow but never widen or change the currency of the intent authorization. For media-buy updates, buyers propose a positive-delta ceiling and sellers independently compute and enforce the actual delta from authoritative state. Indirectly priced tasks require an explicit commitment, including amount zero for verified no-cost work. Critical JWS extensions bind the monetary ceiling, exact task, and canonical payload hash so services can verify authorization without reading governance-private state. Outcome reports authenticate as the original buyer, preserve purchase type, settle an opaque action binding once across all lifecycle check IDs, cache identical retries before mutable plan lookup, validate all monetary inputs, and reserve the governance-owned approved budget rather than trusting a buyer-reported amount.

Publish one cross-language fixture set with JCS payload hashes, decision tables, and 27 byte-exact Ed25519 compact-JWS cases. The cases cover critical markers, audience/caller/task/payload bindings, commitments, time bounds, replay identifiers, signature tampering, and zero-cost authorization using an explicitly test-only public keypair.

This intentionally changes validation on the experimental campaign-governance schemas in the next minor release; integrations on that experimental surface must update together when adopting 3.2.
