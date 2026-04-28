---
---

chore: bump @adcp/client to 5.22.0

Picks up the parse-time + index-time guards for malformed `properties[]` entries in adagents.json (adcp-client#1043) — fixes the `property.identifiers is not iterable` crash that was taking out the AAO crawler on every poll. Also brings the bundled spec from 3.0.0 to 3.0.1 (no wire changes; new sandbox-only test-controller scenarios + envelope-scoped storyboard checks the AAO doesn't use yet). Back-compat aliases preserve `FormatID` and the legacy `RATE_LIMITEDDetails` / `Foo_BarValues` exports so existing imports keep compiling.
