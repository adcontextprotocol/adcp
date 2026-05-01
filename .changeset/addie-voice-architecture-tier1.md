---
---

Reshuffle Addie's rule architecture so character lives in identity.md
(WHO Addie is) and constraints.md keeps only deterministic guardrails
(WHAT Addie WON'T do):

- **identity.md** gains five voice sections that consolidate or replace
  scattered rule-form content elsewhere:
  - **Honesty over confidence** — collapses "No Speculative Answers",
    "Source Attribution", and "No Hallucination" from constraints.md
    plus the character-framing piece of "Tool Unavailable Is Not 'No
    Result'" into one voice section. The deterministic three-outcome
    procedure stays in constraints.md as "Tool Outcomes — Three
    Distinct Cases" (renamed) and references identity.md as authority.
  - **Only enter to add** — replaces "No Empty Affirmation" from
    constraints.md. Same content reframed as character: silence beats
    restating, be useful or be quiet.
  - **Capability reflex** — adds the WHY for behaviors.md "Capability
    Questions: Search docs/aao/ First". The HOW stays in behaviors.md
    and now references identity.md.
  - **Industry stance** — replaces "Industry Diplomacy" from
    constraints.md. Voice version of the same posture.
  - **Welcoming people in** — replaces the procedural "Account Setup
    Priority" section that was already in identity.md. Same intent
    framed as character ("a small invitation, not a sales pitch")
    rather than a step list.
- **Pragmatic optimism** strengthened with concrete framing.
- **constraints.md** loses the five sections moved to identity.md; the
  remaining content is purely deterministic guardrails (no fabrication,
  no unexecuted action claims, fictional names in examples, escalation
  protocol, tool-outcome procedure).
- **behaviors.md** gets a one-line preamble on the Capability Questions
  rule pointing at identity.md as the WHY.

Net prompt mass change: +1.3% (~2KB) — voice content is denser per word
than the rule lists it replaces, so the increase comes from the explicit
identity-as-WHO framing, not duplication.

The architecture now reads cleanly:
  - identity.md   = WHO Addie is (voice, character, values)
  - behaviors.md  = WHAT Addie does (operational procedures, tool routing)
  - constraints.md = WHAT Addie WON'T do (deterministic guardrails)
  - response-style.md = HOW Addie writes (formatting, length, banned phrases)
