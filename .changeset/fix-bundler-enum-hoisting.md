---
---

Fix bundler enum hoisting: add `hoistDuplicateInlineEnums` post-processing step in `scripts/build-schemas.cjs` to detect titled pure-enum schemas inlined 2+ times in a bundled output, hoist them to root `$defs`, and replace duplicates with `$ref` pointers. Eliminates the `AgeVerificationMethod1` numbered-suffix codegen artifact in `json-schema-to-typescript` consumers. Complex object schemas (`BriefAsset1`, `VASTAsset1`, etc.) are intentionally out of scope — see #3145 for the RFC on opt-in `x-hoist` markers.
