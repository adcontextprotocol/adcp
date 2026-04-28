---
---

chore: bump @adcp/client to 5.22.0

Picks up the parse-time + index-time guards for malformed `properties[]` entries in adagents.json (adcp-client#1043) — fixes the `property.identifiers is not iterable` crash that was taking out the AAO crawler on every poll. Also brings the bundled spec from 3.0.0 to 3.0.1 (no wire changes; new sandbox-only test-controller scenarios + envelope-scoped storyboard checks the AAO doesn't use yet). Back-compat aliases preserve `FormatID` and the legacy `RATE_LIMITEDDetails` / `Foo_BarValues` exports so existing imports keep compiling.

The 5.22.0 bundle adds 10 new universal storyboards to the conformance index (pagination integrity per tool, signed-requests, v3 envelope). Three of those (pagination/list-accounts, plus media-buy-seller and creative-template specialism steps) surfaced a latent test-isolation bug in `run-storyboards.ts`: `clearSessions()` only resets the framework's per-session map, so module-level pools in the training agent (account catalogue, comply-controller seed and forced-completion pools, catalog/event-source stores) bled across storyboards. The runner now invokes the existing per-module `clear*` helpers between storyboards. The fourth (`v3_envelope_integrity`) is on a new known-failing list pinned to adcp#3429 — the storyboard asserts envelope `status` while pointing `response_schema_ref` at the inner per-tool schema, and the framework's auto-registered `get_adcp_capabilities` returns the unenveloped payload.
