---
---

Training agent: revert three storyboard-fitting hacks. Each masked a
real storyboard or test_kit bug that's now tracked upstream — we'd
rather fail the tests honestly than ship behavior buyers won't hit.

- **Revert `standard_monthly` pricing alias** (brand-handlers.ts). The
  `brand_rights` storyboard hardcodes this ID but it's not in any
  offering's actual pricing options. Real buyers capture the ID from
  `get_rights`. Tracked in #2627 (advertiser vs talent brand_id
  confusion).
- **Revert talent filter fallback** (brand-handlers.ts). Was returning
  all talent when `brand_id` didn't exact-match — masked the
  storyboard's semantic confusion between advertiser brand_id and
  talent brand_id. Tracked in #2627.
- **Revert `feedback.satisfaction` → `performance_index` mapping**
  (catalog-event-handlers.ts). The spec requires `performance_index`
  (number); the SDK test_kit sends a non-spec `feedback` object with
  satisfaction strings. Tracked in #2626.

Also filed the three compliance improvement issues this audit surfaced:
#2623 (schema-driven dispatcher validation), #2624 (buyer-side SDK
smoke test), #2625 (property-based tests), plus #2628 (double-cancel
storyboard contradiction) and #2629 (past-start any_of reporting).

Storyboard score regresses 41/55 → 39/55 (296 → 292 steps) but the
fake-clean count goes away. We re-clean these when the upstream fixes
land.
