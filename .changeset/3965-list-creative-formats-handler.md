---
---

fix(training-agent): wire listCreativeFormats on /creative and /creative-builder tenants — closes #3965 Class F

The v6 `CreativeAdServerPlatform` (used by `/creative` tenant) and `CreativeBuilderPlatform` (used by `/creative-builder` tenant) didn't expose `listCreativeFormats`. The v5 handler `handleListCreativeFormats` exists and the `/sales` tenant already wires it through; the two creative tenants were missing the wiring.

Symptom: `pagination_integrity_creative_formats` storyboard failed on the `first_page` step with `UNSUPPORTED_FEATURE: list_creative_formats: this creative platform did not implement listCreativeFormats. Add listCreativeFormats(req, ctx) to your CreativeBu...`

Storyboard adoption catalog (`tool-catalog.ts`) was already updated in #3962 to advertise `list_creative_formats` on `creative` and `creative-builder` — that change reflected the SDK's framework-registration. This PR fills in the actual handler the framework dispatches to.

**Files:**
- `server/src/training-agent/v6-creative-platform.ts`: import `handleListCreativeFormats`, add `listCreativeFormats` method on `creative` interface.
- `server/src/training-agent/v6-creative-builder-platform.ts`: same shape.

**Per-tenant impact (post overlay-cache):**
- `/creative`: 56/67 clean / 69 passed → **64/67 clean / 79 passed** (+8 clean, +10 passed)
- `/creative-builder`: 52/67 clean / 51 passed → **58/67 clean / 61 passed** (+6 clean, +10 passed)

Floor raises land in a follow-up after #3974 (the Class B+D fix-up that already raises floors) merges, to avoid conflict.

**Related #3965 catch-up state after this PR:**
- ✅ Class B (UNKNOWN_SCENARIO error coarsening) — #3974
- ✅ Class D (idempotency_key dead capture) — #3974
- ✅ Class F (seed_creative_format / listCreativeFormats handler) — this PR
- ✅ Class G (REFERENCE_NOT_FOUND) — was a stale-cache phantom, source already correct
- 🟡 Class A (comply_test_controller context echo) — adcp-client#1455 (SDK gap)
- 🟡 Class C (signed_requests /mcp-strict discovery) — predates the bump
- 🟡 Class E (force_create_media_buy_arm directive shape) — needs reproducer
