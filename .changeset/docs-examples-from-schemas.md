---
"adcontextprotocol": patch
---

Docs payload examples now render from the schema `examples`, so they cannot drift from the schemas. A docs JSON block that names its `$schema` carries a `{/* schema-example: #/examples/<index> */}` marker, and `npm run build:docs-examples` writes the block from that example. 560 docs blocks render this way; 519 instances that existed only in the docs moved into the `examples` of 168 schemas. 71 of them were missing a required field with an evident value: `status: "completed"` on a synchronous task response, or an `idempotency_key` on a mutating request. `npm run test:docs-examples` fails when a bound block is stale, when a block with an AdCP `$schema` has no marker, or when an unbound block copies a schema example.
