---
"adcontextprotocol": patch
---

Document the `translateUniversalMacros` SDK helper under `docs/creative/universal-macros`.

Adds an "Implementing translation with the SDK" example showing how a sales agent translates universal macros in a pixel URL: `native` mappings (ad-server tokens, inserted raw) vs `value` mappings (RFC-3986 percent-encoded), parameters with unmapped macros dropped (inspect `unmapped_macros` for forgotten consent macros), already-minted params untouched, and the `suspect_native_values` wrong-arm signal. The helper ships in `@adcp/sdk` (adcontextprotocol/adcp-client#2263).
