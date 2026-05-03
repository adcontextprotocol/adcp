---
"adcontextprotocol": minor
---

Add `produced_by` enum to `format.assets[]` slots to distinguish buyer-provided inputs from creative-agent-generated outputs.

`produced_by: 'buyer'` (default, backward-compatible) means the buyer provides the asset in `build_creative` input requests. `produced_by: 'build_creative'` means the creative agent generates the asset in the response; buyers MUST NOT include it in input requests, and implementations MUST reject requests that supply a value for such a slot.

Added to both `baseIndividualAsset` and `baseGroupAsset` definitions. Resolves conformance ambiguity in adapters that currently declare output slots using `required: false` because no better discriminator existed. Closes #4021.
