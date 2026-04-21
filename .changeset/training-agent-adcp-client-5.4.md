---
---

Training agent: upgrade to `@adcp/client` 5.4 and adopt the new
`customTools` + `AdcpServer` APIs.

5.4 closes the five upstream asks we surfaced in 5.3:

- `createAdcpServer()` now returns an opaque `AdcpServer` type (closes
  the CJS/ESM dual-package hazard).
- `AdcpServer.dispatchTestRequest({ method, params })` replaces the
  `_requestHandlers` reach-through.
- `McpToolResponse.structuredContent` is optional.
- `SingleAgentClient.validateRequest` drops `.strict()` — no more
  runner monkey-patch.
- Storyboard runner accepts `request_signing.transport: 'mcp'` for
  MCP-only agents grading the `signed-requests` specialism.
- New `AdcpCustomToolConfig` / `config.customTools` lets downstream
  agents register tools outside `AdcpToolMap` through the framework
  config rather than reaching for `getSdkServer()`.

## What changed in this repo

- **`framework-server.ts`**: return type changes from `any` to
  `AdcpServer`. The 9 non-`AdcpToolMap` tools (`creative_approval`,
  `update_rights`, `comply_test_controller`,
  `validate_property_delivery`, 5× `*_collection_list`) now register
  via the `customTools:` config instead of `server.registerTool()`
  after construction. No more escape hatches.
- **`run-storyboards.ts` / `run-one-storyboard.ts`**: drop the
  33-line `SingleAgentClient.validateRequest` monkey-patch (upstream
  fixed). Pass `request_signing: { transport: 'mcp' }` so
  `signed_requests` vectors route through our MCP transport instead
  of per-operation HTTP URLs.

## Results

- **437/437 unit + integration tests green** with the flag OFF.
- **29/55 storyboards clean, 214 steps passing** (unchanged from 5.3
  on the legacy path — expected, since the flag is still OFF by
  default).
- **`signed_requests` vectors now reach our `/mcp` endpoint** (401
  instead of 404 — they fail because bearer auth runs before
  signature verification, which is tracked as a separate follow-up:
  the two should compose via `anyOf` auth-or-signature semantics).
