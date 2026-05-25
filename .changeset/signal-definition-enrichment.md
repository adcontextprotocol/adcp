---
"adcontextprotocol": minor
---

Extend `core/signal-definition.json` with definition-side signal enrichment for taxonomy metadata, DTS-aligned source/methodology disclosures, modeling metadata, jurisdiction applicability, consent basis, and per-signal data-subject-rights routing.

Taxonomy is modeled as signal-definition metadata rather than a new `signal-value-type`, so package targeting continues to use the existing binary, categorical, and numeric expression grammar. Parent taxonomy node expansion is declared as seller behavior through `taxonomy.parent_match_behavior` instead of being implied by the schema.

Adds a signal-specific `core/signal-modeling-disclosure.json` instead of reusing creative `provenance.disclosure`, because data-signal modeling disclosure has different semantics from content provenance and render guidance.
