---
"adcontextprotocol": minor
---

test(compliance): add canonical format satisfaction create-time coverage.

Defines the direct `PackageRequest.format_kind`/`params` canonical selector used by the negative under-specification case and publishes the runner-output contract for `canonical_format_satisfaction`.

Read surfaces now echo supplied format selectors losslessly, and update payloads treat all format selector fields as immutable.
