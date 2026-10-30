---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): billing coverage has no unowed stretch, and the flight ends when delivery stops.

- **Billing stubs.** When a cutover hands periods to a billing feed whose schedule has no boundary at the handoff instant E, the stretch from E to the first incoming boundary is now owed as one stub period instead of under neither schedule. Its obligation carries the new `stub: true` (`core/reporting-obligation.json`, billing only). This covers account timezone changes on billing offerings, so no billable hour goes unreported. Pacing and analytics feeds still leave the stretch unowed.
- **Delivery stop on cancellation.** `cancellation_effective_at` (experimental), a sibling of `cancellation` on `core/media-buy.json` and `get_media_buys`, is when delivery stops under the cancellation, later than `canceled_at` when the seller delivers through a notice period. Sellers advertising `media_buy.reporting_subscriptions` MUST populate it, and the coverage rule's stop time uses it instead of the instant the cancellation was recorded.
- **Delivery stays inside the flight.** A seller advertising `media_buy.reporting_subscriptions` MUST NOT deliver on a buy outside its flight. To deliver later, including a make-good under `makegood_policy` remedy `additional_delivery`, it first extends `end_time`; a canceled or completed buy's make-good goes on a subsequent buy.
