---
"adcontextprotocol": minor
---

Add optional `last_updated` (date-time) to `signal-definition.json`, `signal-definition-enrichment.json`, and the `get_signals.fields` projection enum.

Closes the signal-record freshness gap raised in #5248. `refresh_cadence` and `lookback_window` describe methodology freshness; `last_updated` tells buyer agents when the seller last published or updated this specific definition record — the one verifiable freshness signal that agents can compare across providers without trusting self-declared methodology claims.

Description follows `signal-listing.json` precedent: "When this definition record was last updated. This indicates freshness of the definition record, not an attestation that the underlying data or model was refreshed at that time."

Adding to `signal-definition-enrichment.json` means the field is also projectable through `get_signals.fields` for buyers that want it inline during discovery without fetching the full definition.
