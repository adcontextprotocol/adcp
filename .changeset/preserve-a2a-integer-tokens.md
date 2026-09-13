---
"adcontextprotocol": patch
---

Add a transport-safe AdCP 3.2 A2A profile at `/extensions/adcp/v3.2` that carries complete request and response envelopes as JSON text through `google.protobuf.Value.string_value`. This preserves required `revision` and nested `expected_overlay_revision` integer tokens for schema-derived implementations while leaving the published `/v3` object-valued wire profile and integer schemas unchanged. Portable conformance vectors cover request and response revisions, lossy legacy widening, malformed JSON, media-type enforcement, and rejection of object-valued fallbacks.
