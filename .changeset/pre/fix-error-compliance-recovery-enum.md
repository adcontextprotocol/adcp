---
"adcontextprotocol": patch
---

Fix `VERSION_UNSUPPORTED` recovery value in `error-compliance.yaml` storyboard prose.

Two occurrences of `fatal` (which is not in the `recovery` enum) have been corrected:
- `unsupported_major_version` step `expected:` block: `recovery: fatal` → `recovery: correctable`, matching `enumMetadata.VERSION_UNSUPPORTED.recovery` across all 3.x bundles.
- General error-shape narrative: `correctable, transient, or fatal` → `transient, correctable, or terminal`, matching the enum declaration order in `core/error.json`.

The storyboard validations do not assert `recovery`, so no existing conformance test is affected. This corrects misleading prose that could cause hand-implementers to emit schema-invalid error envelopes.
