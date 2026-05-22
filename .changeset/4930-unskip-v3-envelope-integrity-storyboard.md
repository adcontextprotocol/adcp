---
"adcontextprotocol": patch
---

fix(compliance): unskip v3_envelope_integrity storyboard — inject envelope status via customTools

The v6 SDK framework's auto-registered `get_adcp_capabilities` handler returns the
capabilities payload directly into `structuredContent` without calling `wrapEnvelope`,
so `status: 'completed'` is absent. The `v3_envelope_integrity` universal storyboard
was skipped in `KNOWN_FAILING_STORYBOARDS` pending this fix.

All six per-tenant v6 routes (sales, signals, governance, creative, creative-builder,
brand) now register `get_adcp_capabilities` in `serverOptions.customTools` via the
existing `customToolFor` helper, which calls `wrapEnvelope` and adds `status:
'completed'` plus `context` echo to every response. This shadows the SDK's
auto-generated handler with a conformant envelope-wrapped version.

`KNOWN_FAILING_STORYBOARDS` entry for `v3_envelope_integrity` is removed; the
storyboard now runs on every tenant in the matrix and asserts the canonical v3
`status` field is present on `get_adcp_capabilities` responses.

Closes #4930.
