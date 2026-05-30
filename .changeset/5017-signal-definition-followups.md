---
"adcontextprotocol": patch
---

Clarify progressive disclosure for enriched signal definitions: provider-published signals resolve through `signal_ref` to `adagents.json` and cache with `catalog_etag` or HTTP validators, while rich fields can still be requested inline for exact lookup, custom, or private signals.

Clarify runtime validation requirements for enriched signal definitions, including draft-07 conditional constraints, data-subject-rights channel requirements, Article 9 checks, federation handling for `countries[]`, and the verification limits of `provider_signed`. Remove signal-level Global Privacy Control handling from the DSR surface; signal definitions do not declare GPC support, and consumers must not infer GPC handling from DSR routing metadata.
