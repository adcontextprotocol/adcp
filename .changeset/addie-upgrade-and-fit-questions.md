---
---

Addie behavior updates driven by escalation #281 (Vladimir Houba),
expanded after expert review.

- **knowledge.md** — New FAQ row for upgrade pricing. Every tier is
  a Stripe subscription (credit card or invoice); Stripe prorates
  upgrades automatically regardless of collection method, so the
  user typically pays only the prorated difference, not the full new
  tier on top. Worked examples for Explorer → Professional and
  Builder → Partner. Invoice-billed subscriptions see the prorated
  charge on their next invoice instead of an immediate card charge —
  same numbers, different timing.
- **constraints.md** — "Do NOT escalate" list under Escalation
  Protocol calling out community-fit questions and routine
  credit-card pricing. Replaces the bundled-question one-liner with
  a decomposition procedure (split, decide per part, default
  answer-all-parts) and a worked example using Vladimir's actual
  question.
- **behaviors.md** — "Individual Practitioner Suitability" now has a
  peer-register sub-clause: skip the reassurance script ("Basics is
  free", "no coding") for senior practitioners (10+ years RTB / DSP /
  ad-ops), and instead name the working group(s) where their depth
  is load-bearing. Adds a sequencing rule for fit + pricing bundled
  questions: affirm fit → name path → reassure friction-free upgrade,
  in that order.
- **escalation-tools.ts** — Tightens the `escalate_to_admin` tool
  description so it stops winning negative-rule contests. Softens
  "too complex or sensitive for you to handle" to "requires admin
  judgment, account access, or a human action you cannot perform"
  and adds explicit DO-NOT-USE-FOR entries for community-fit,
  routine pricing, and decomposable multi-part questions.
