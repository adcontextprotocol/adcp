---
---

chore: bump @adcp/sdk to 5.25.1 and re-enable unsupported_major_version probe

5.25.1 lands two upstream fixes that unblock the storyboard skip we shipped
alongside the 5.25.0 bump:

- `adcontextprotocol/adcp-client#1073` restores caller-wins on the wire
  version envelope so the storyboard's `adcp_major_version: 99` probe
  reaches the seller verbatim (5.24/5.25.0 silently rewrote it to the SDK
  pin via `ProtocolClient.callTool`).
- `adcontextprotocol/adcp-client#1080` adds the matching server-side
  single-field `VERSION_UNSUPPORTED` check in `createAdcpServer`, so a
  buyer claim outside the seller's advertised window now gets rejected
  with `details.supported_versions` populated for retry.

`error_compliance/unsupported_major_version` is removed from
`KNOWN_FAILING_STEPS`; both dispatches stay clean (framework: 64/64
clean, 457 passed; legacy: 64/64 clean, 439 passed).
