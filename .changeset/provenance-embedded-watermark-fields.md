-
"adcontextprotocol": minor
-

Add embedded_provenance and watermarks arrays to provenance schema, expand creative-policy with provenance_requirements object

Two new optional arrays on `provenance.json` distinguish between provenance metadata carried within the content stream (`embedded_provenance`) and content watermarks that encode an identifier or fingerprint (`watermarks`). The separation aligns with C2PA's normative taxonomy: embedded provenance maps to binding assertions and manifest embedding (Section A.7), while watermarks map to the `c2pa.watermarked.*` action family.

A new `provenance_requirements` object on `creative-policy.json` gives sellers structured, field-level provenance requirements beyond the existing `provenance_required` boolean. The object refines `provenance_required`: it is only meaningful when the boolean is true, and receivers ignore it otherwise. All new fields are optional and additive; existing agents are unaffected.

The `c2pa` field description on `provenance.json` is updated to note that sidecar manifest bindings break during ad-server transcoding, with a reference to `embedded_provenance` as the alternative for intermediary pipelines.

New enum files: `embedded-provenance-method.json`, `watermark-media-type.json`, `c2pa-watermark-action.json`.

Closes #2854 (Option A: must-carry baseline expansion).
