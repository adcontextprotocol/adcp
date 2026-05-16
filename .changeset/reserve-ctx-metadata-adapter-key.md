---
"adcontextprotocol": patch
---

spec(conventions): reserve `ctx_metadata` as adapter-internal round-trip key

Reserves the top-level key `ctx_metadata` on AdCP resource objects (Product, MediaBuy, Package, Creative, AudienceSegment, Signal, RightsGrant) as a publisher-to-SDK round-trip cache for adapter-internal state. SDKs MUST strip the key before wire egress and MUST emit a warning-level log entry when stripping, so operators can detect accidental collisions with existing adapter code. Buyers never see this field.

The convention is non-binding at the wire level — these resources already declare `additionalProperties: true` so existing payloads remain valid. The reservation locks the keyword name before two SDKs converge on it accidentally and ship divergent semantics. PropertyList and CollectionList are out of scope (`additionalProperties: false`) until a follow-up PR widens those schemas.

Closes #3640.
