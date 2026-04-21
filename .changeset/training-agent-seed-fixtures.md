---
---

Training agent: implement `seed_*` scenarios on `comply_test_controller`.

Adds `seedProduct`, `seedPricingOption`, `seedCreative`, `seedPlan`, and
`seedMediaBuy` methods to the `TestControllerStore`, wired through the
SDK's `createSeedFixtureCache()` for same-ID-different-fixture idempotency
enforcement.

Fixtures are permissive merges (spec: `additionalProperties: true`) over
sensible defaults so storyboards can declare minimal shapes. Seeded
products and pricing options land in a session-scoped `complyExtensions`
overlay; creatives, plans, and media buys land directly in the existing
session maps.

Per spec, seeds are not advertised via `list_scenarios` — the SDK
dispatcher routes them based on method presence alone.

Complement to upstream work on specialism invariants (#2639) and the
`fixtures:` block in storyboards (#32). Storyboards don't yet populate
`fixtures:`, so this ships the agent-side capability ahead of the
runner-side adoption. When upstream storyboards start using
`controller_seeding: true`, the five storyboards that currently fail
with MEDIA_BUY_NOT_FOUND / NOT_FOUND errors on hardcoded fixture IDs
(governance_spend_authority, media_buy_governance_escalation,
creative_ad_server, sales_non_guaranteed, governance_delivery_monitor)
should close automatically.
