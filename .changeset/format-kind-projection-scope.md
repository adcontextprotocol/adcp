---
"adcontextprotocol": patch
---

Docs: the `core/canonical-format-kind.json` description and the promotion contract in `canonical-formats.mdx` now limit `format_kind` projection to product format declarations (adcp#7929). There `format_kind` is the discriminator of `product-format-declaration.json`, so a seller serving 3.1 or earlier projects a declaration with a 3.2-only kind or omits it. Everywhere else, a newer kind is a new enum value: it is exempt from projection under [Serving an older pin](/docs/reference/versioning#serving-an-older-pin), and clients tolerate it under the [Enums](/docs/reference/versioning#3-x-stability-guarantees) rule. The descriptions no longer say a strict older schema correctly rejects a newer kind anywhere it appears. No schema changes beyond the description.
