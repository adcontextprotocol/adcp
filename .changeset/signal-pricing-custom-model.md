---
"adcontextprotocol": minor
---

Add `custom` pricing model to the vendor pricing schema as an escape hatch for constructs that do not fit cpm, percent_of_media, flat_fee, or per_unit.

`model: "custom"` requires a human-readable `description` and a structured `metadata` object. Buyers SHOULD route custom pricing through operator review before commitment — automatic selection is not recommended.

Shipping this now is cheap and avoids painful retrofit when data providers introduce performance kickers, tiered volume, hybrid (flat + CPM) pricing, or outcome-shared constructs that the enumerated models cannot express. Structured metadata keeps the field machine-inspectable without forcing a schema change for every new pattern.

Applies to all `signal-pricing.json` consumers (signals, creative, governance vendor pricing via `vendor-pricing-option.json`). `get_signals` task documentation is updated to reflect the new model.
