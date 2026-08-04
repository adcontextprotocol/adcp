---
"adcontextprotocol": minor
---

Add an optional per-package `daily_budget_cap` (RFC #5983). Buyers running against client-approved daily authorizations or ROAS floors had no protocol path to bound per-day spend — only `budget`, `pacing`, and the flight window, none of which is a hard daily ceiling (documented as a known gap in #4429 / PR #5984).

- **`package-request.json` / `package-update.json`** gain `daily_budget_cap` (number, media-buy currency) and an optional `budget_cap_timezone` override. The cap is orthogonal to `pacing` (it bounds the daily maximum; pacing governs within-day distribution — `pacing: "asap"` plus a cap is coherent).
- **Package response echo** — `core/package.json` (the shape `create-media-buy-response` and `update-media-buy-response` reference) and the inline package shape in `get-media-buys-response.json` both echo the accepted `daily_budget_cap` and resolved `budget_cap_timezone`, so buyers can verify enforcement and reconcile enforced-vs-requested across every read surface.
- **`get-adcp-capabilities-response.json`** gains a `media_buy.budget_capping` capability object (`supported_periods`, `enforcement` [`hard`/`soft`], `effective_timezone`, optional `buyer_timezone_override`), modeled on the existing `frequency_capping` block. Sellers not declaring support MUST reject `daily_budget_cap` with `UNSUPPORTED_FEATURE` rather than silently dropping it.

Timezone follows the seller's billing day boundary: `budget_capping.effective_timezone` MUST equal `get_account_financials.timezone` when financials are available, so cap resets and invoice periods share one boundary; DST transition days count as one local calendar day carrying the full cap. Scope is `day` only (the `supported_periods` array reserves room for future periods additively); `daily_impression_cap` parity is left to a follow-up per the RFC's open WG questions.
