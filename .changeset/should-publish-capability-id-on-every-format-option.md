---
"adcontextprotocol": patch
---

Add SHOULD on `product-format-declaration.json`: sellers SHOULD publish `capability_id` on every `format_options[]` entry — not just when structurally required to break a `format_kind` collision. Without it, V2-mental-model buyers using the `PackageRequest.capability_ids[]` path added in #4845 (and the long-standing `creative-manifest.capability_id`) can't address the entry, fall back to v1 `format_ids[]`, and lose the cross-publisher-stable naming the V2 authoring path was designed to provide.

Co-located with #4845's buyer-side change so 3.1 release-notes readers see the buyer capability and the seller obligation together. No structural change — capability_id remains optional at the schema level; this is description-text only. The 4.0 cutover will tighten SHOULD → MUST (tracked in #4857).

Closes #4856.
