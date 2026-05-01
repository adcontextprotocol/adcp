---
"adcontextprotocol": minor
---

feat(provenance): embedded_provenance, watermarks, and field-level requirements with structured rejection codes

Two new optional arrays on `provenance.json` distinguish between provenance metadata carried within the content stream (`embedded_provenance`) and content watermarks that encode an identifier or fingerprint (`watermarks`). The separation aligns with C2PA's normative taxonomy: embedded provenance maps to binding assertions and manifest embedding (Section A.7), while watermarks map to the `c2pa.watermarked.*` action family. Each entry MAY carry a `verify_agent` pointer at an AdCP governance agent that can verify the embedding via `get_creative_features` — verification happens through the existing AdCP governance surface, not a vendor-specific webhook.

A new `provenance_requirements` object on `creative-policy.json` gives sellers structured, field-level provenance requirements beyond the existing `provenance_required` boolean: `require_digital_source_type`, `require_disclosure_metadata`, `require_embedded_provenance`. Sellers that publish a requirement MUST enforce it on `sync_creatives` with a structured error code from the new `PROVENANCE_*` family on `error-code.json`:

- `PROVENANCE_REQUIRED` — no provenance object on the creative
- `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING` — required `digital_source_type` absent
- `PROVENANCE_DISCLOSURE_MISSING` — required `disclosure` block absent
- `PROVENANCE_EMBEDDED_MISSING` — required `embedded_provenance` entry absent
- `PROVENANCE_CLAIM_CONTRADICTED` — independent verifier (e.g., `get_creative_features` against the buyer's nominated `verify_agent`) refutes the buyer's claim

These codes are correctable: a buyer's orchestrator reads them, fixes the creative, and resubmits without negotiating with the seller. The truth-of-claim surface lives in `get_creative_features`; the structural-rejection surface lives in `sync_creatives`.

The `c2pa` field description on `provenance.json` is updated to note that sidecar manifest bindings break during ad-server transcoding, with a reference to `embedded_provenance` as the alternative for intermediary pipelines.

New enum files: `embedded-provenance-method.json`, `watermark-media-type.json`, `c2pa-watermark-action.json`. New compliance scenario: `protocols/media-buy/scenarios/provenance_enforcement.yaml` walks the structural-rejection contract end to end (discover requirement → reject missing-disclosure → accept corrected resubmission).

All wire additions are optional and additive; existing agents that do not read the new fields are unaffected.

Closes #2854 (Option A: must-carry baseline expansion + Track 1: embedded provenance field shape).
