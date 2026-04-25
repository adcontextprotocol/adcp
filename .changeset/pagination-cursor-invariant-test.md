---
---

Pagination cursor↔has_more invariant: new authoring lint (`scripts/lint-pagination-invariant.cjs`) plus a universal storyboard (`pagination-integrity`) that walks `list_creatives` from a continuation page to a terminal page with three seeded fixtures and `max_results=2`.

The lint scans schema `examples[]` payloads and storyboard `sample_request` / `sample_response` fixtures for the two violation classes the prose contract on `pagination-response.json` doesn't enforce: `has_more=true` without a `cursor`, and `has_more=false` with a stale `cursor`. Wired into the `test` chain.

The storyboard catches the dishonest-pagination case at runtime — an agent that hides the seeded third creative behind `has_more=false` on the first page fails the first-page assertion, and an agent that carries a stale cursor onto the terminal page fails the second-page assertion. `total_count` is intentionally unchecked since the schema permits omission.

Also fixes the training agent's `list_creatives` to honor `pagination.max_results` (default 50, capped at 100 per the request schema) and emit an opaque base64url offset cursor when the page is non-terminal. Previously every response carried `has_more: false` regardless of input, the exact dishonest shape the new storyboard catches.
