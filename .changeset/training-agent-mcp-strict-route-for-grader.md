---
---

Training agent: add `/mcp-strict` route for the conformance grader.

The public sandbox `/mcp` route stays at `required_for: []` — unsigned
bearer callers (Addie, demos, quickstart users) keep working without
signing infrastructure. A new `/mcp-strict` route advertises
`required_for: ['create_media_buy']` and enforces it with a presence-
gated authenticator so `adcp grade request-signing` vector 001
(`request_signature_required`) fires against a real deployment.

The strict authenticator closes the two gaps in the default route's
`anyOf(bearers, signing)` composition:

- Present-but-invalid signatures no longer fall through to bearer.
- Unsigned calls to ops in `required_for` return the canonical AdCP
  error code in the 401 body, not the generic RFC 6750 `invalid_token`.

Non-required ops still accept bearer on the strict route, so grader
setup (list_tools, get_products, discovery probes) works without
signing infrastructure.

Closes #2368 via dual-routing (Option 3 in the issue thread). Upstream
SDK helper for the presence-gated composition pattern is tracked as
adcp-client#659.
