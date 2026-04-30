---
---

chore: bump @adcp/sdk to 5.25.0

Picks up the AdCP 3.1 release-precision version envelope (5.25.0) and per-instance `adcpVersion` validator/protocol plumbing (5.24.0). No call-site changes required — we don't construct `ProtocolClient` directly and don't reference the renamed `requireV3` (still kept as a deprecated alias). Behavior is unchanged on the default 3.0 pin; the new wire field activates only when a 3.1 schema bundle ships.
