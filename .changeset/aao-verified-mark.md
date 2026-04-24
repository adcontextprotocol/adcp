---
---

spec(conformance): AAO Verified mark via continuous delivery observability (transitional)

Adds an optional top-tier trust mark **AAO Verified**, separate from **AdCP Conformant** (the storyboard-issued mark). Two marks with a containment relationship: AAO Verified ⊆ AdCP Conformant. *Conformant* attests wire-format correctness (storyboards pass). *Verified* attests that the seller's live ad-server integration actually delivers real impressions on real inventory — something storyboards cannot prove because `simulate_delivery` is a parallel code path from production reporting.

Earlier drafts used a "Tier 1 / Tier 2" framing; this PR drops that language because tiering the same word "verified" across two different kinds of claim muddied the buyer signal. AdCP Conformant and AAO Verified are distinct claims, not tiers of one claim, with Verified strictly implying Conformant.

Seller obligation for AAO Verified: designate a compliance account with real live campaigns (PSA / remnant / house / genuine revenue all qualify) and grant the `attestation_verifier` scope (#2964) to the AAO compliance engine. Eight observable checks run over a 7–14 day rolling window. Mark states: Active / Quiet-Period-Declared / Lapsed. Path B (brownfield) has two first-class forms — B1 polling-only, B2 webhook-attached.

Closes #2965. **Transitional** — a follow-up RFC ([#3046](https://github.com/adcontextprotocol/adcp/issues/3046)) proposes moving AAO Verified from enrollment-based continuous observation to AAO-operated canonical test campaigns per specialism. The machinery in this PR (eight checks, `attestation_verifier` scope, Path A/B, webhook-ownership contract) is reusable either way; only the issuance trigger changes at the end state.

Depends on #2964 (`attestation_verifier` scope + RBAC error codes) and on the merged #2963 account-ownership tightening. Multi-subscriber webhooks (which relax the dedicated-tenant requirement on Path B2) tracked for 4.0 in #3009.
