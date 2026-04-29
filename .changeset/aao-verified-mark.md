---
"adcontextprotocol": minor
---

spec(conformance): AAO Verified — one brand mark, two qualifiers (Spec) and (Live)

Adds **AAO Verified** as the public trust mark for AdCP agents, with two composable qualifiers in parens — **(Spec)** and **(Live)** — that an agent can hold either or both:

- **AAO Verified (Spec)** — your AdCP wire format matches the spec. Storyboards run against your test-mode endpoint on AAO's compliance heartbeat. Issued automatically when storyboards pass for the agent's declared specialisms + active AAO membership.
- **AAO Verified (Live)** — AAO has observed real production traffic flowing through your agent. The compliance engine continuously watches delivery against your live ad-server integration over a 7–14 day rolling window. Lights up in 3.1 once the canonical-campaign runner is operational; the eight-check observability machinery already ships.

(Spec) is a prerequisite for (Live) because a broken protocol implementation makes live observation unmeasurable. The two qualifiers share one brand mark — buyers learn one name, the qualifier in parens names which axis was earned.

Earlier drafts used "AdCP Conformant" + "AAO Verified" as two distinct mark names (and earlier still, "Tier 1 / Tier 2"). The single-brand-with-qualifiers framing is cleaner: a test agent earning **Verified (Spec)** is a complete claim, not a "junior" tier.

Seller obligation for (Live): designate a compliance account with real live campaigns (PSA / remnant / house / genuine revenue all qualify) and grant the `attestation_verifier` scope (#2964) to the AAO compliance engine. Eight observable checks run over the rolling window. Path B (brownfield) has two first-class forms — B1 polling-only, B2 webhook-attached. Mark lifecycle: continuous observation, auto-expiring on signal degradation, no one-shot pass.

Closes #2965. Depends on #2964 (`attestation_verifier` scope + RBAC error codes) and the merged #2963 account-ownership tightening. Multi-subscriber webhooks (which relax the dedicated-tenant requirement on Path B2) tracked for 4.0 in #3009.
