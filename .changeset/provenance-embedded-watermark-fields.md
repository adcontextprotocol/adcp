---
"adcontextprotocol": minor
---

feat(provenance): embedded_provenance, watermarks, accepted_verifiers, and structured rejection codes

Two new optional arrays on `provenance.json` distinguish between provenance metadata carried within the content stream (`embedded_provenance`) and content watermarks that encode an identifier or fingerprint (`watermarks`). The separation aligns with C2PA's normative taxonomy: embedded provenance maps to binding assertions and manifest embedding (Section A.7), while watermarks map to the `c2pa.watermarked.*` action family.

The verifier contract follows seller-publishes / buyer-represents / seller-confirms:

- **Seller publishes** `creative_policy.accepted_verifiers[]` — the governance agents it operates or has allowlisted, each with `agent_url`, optional `feature_id`, and optional `providers[]`. Returned on `get_products`.
- **Buyer represents** on each `embedded_provenance[]` and `watermarks[]` entry by attaching `verify_agent: { agent_url, feature_id? }` whose `agent_url` matches a published `accepted_verifiers[]` entry (canonicalized).
- **Seller confirms** by cross-checking the URL against its allowlist before any outbound call, then invoking `get_creative_features` against the matching on-list agent. Sellers MUST NOT call buyer-asserted endpoints outside their allowlist.

This closes the SSRF / exfil / phishing surface a buyer-controlled URL would otherwise create, and matches how publishers actually pick verifiers (they run their own pipeline; buyer-attached evidence is supplementary, not authoritative).

A new `provenance_requirements` object on `creative-policy.json` gives sellers structured, field-level provenance requirements: `require_digital_source_type`, `require_disclosure_metadata`, `require_embedded_provenance`. Sellers that publish a requirement MUST enforce it on `sync_creatives` with the matching error code from the new `PROVENANCE_*` family on `error-code.json`:

- `PROVENANCE_REQUIRED` — no provenance object on the creative
- `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING` — required `digital_source_type` absent
- `PROVENANCE_DISCLOSURE_MISSING` — required `disclosure` block absent
- `PROVENANCE_EMBEDDED_MISSING` — required `embedded_provenance` entry absent
- `PROVENANCE_VERIFIER_NOT_ACCEPTED` — `verify_agent.agent_url` is off the seller's `accepted_verifiers` list (cross-checked before any outbound call)
- `PROVENANCE_CLAIM_CONTRADICTED` — on-list verifier (called via `get_creative_features`) refutes the buyer's claim

These codes are correctable: a buyer's orchestrator reads them, fixes the creative, and resubmits without negotiating with the seller. `PROVENANCE_CLAIM_CONTRADICTED.error.details` is constrained to the audit-safe allowlist `{ agent_url, feature_id, claimed_value, observed_value, confidence, substituted_for }` so verifier responses cannot leak cross-tenant or PII data.

The `c2pa` field description on `provenance.json` is updated to note that sidecar manifest bindings break during ad-server transcoding, with a reference to `embedded_provenance` as the alternative for intermediary pipelines.

New enum files: `embedded-provenance-method.json`, `watermark-media-type.json`, `c2pa-watermark-action.json`. New compliance scenario: `protocols/media-buy/scenarios/provenance_enforcement.yaml` walks the structural-rejection contract end to end (discover requirement → reject off-list verifier → reject missing disclosure → accept corrected resubmission).

All wire additions are optional and additive; existing agents that do not read the new fields are unaffected.

Closes #2854 (Option A: must-carry baseline expansion + Track 1: embedded provenance field shape).
