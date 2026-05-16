---
"adcontextprotocol": patch
---

Cap response body size on AAO discovery fetches. `@adcp/sdk` now ships native `transport.maxResponseBytes` support (mid-stream abort with `ResponseTooLargeError`), so we pass it to the three `AdCPClient` constructors in `capabilities.ts`: 4 MB for `discoverMCPTools` / `discoverA2ATools` (legitimate large agents reach ~2 MB with 500 tools) and 1 MB for `fetchMeasurementCapabilities`. Closes #3731.

Known limitation: `getAgentInfo` / `mcpClient.listTools()` in the SDK do not yet route through the size-limit wrapper, so the 4 MB cap on the discovery constructors is dormant until the SDK wraps that path. Tracking upstream.
