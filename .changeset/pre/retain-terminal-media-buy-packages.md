---
"adcontextprotocol": minor
---

Require package retention on canceled and completed media buys beginning with AdCP 3.3. Preserve records held at adoption and packages subsequently created or observed, including stable identities, correlation data, platform mappings, and the latest recorded committed configuration regardless of origin. Disclose irrecoverable earlier or never-observed external history through nonfatal errors rather than silently returning an incomplete list. Preserve prior terminal package outcomes and original cancellation metadata; the buy's terminal state stops all package serving. Released creative assignments remain released, and missing statistics must not be reported as zero delivery. Explicitly document that responses served as AdCP 3.2 permit empty terminal package lists and offer no retention guarantee.

Add a 3.3 stateful conformance scenario that verifies complete package readback after individual and whole-buy cancellation, including stable product and buyer mappings, a committed configuration update, and preserved earlier cancellation metadata.
