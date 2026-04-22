---
---

Training agent: adopt @adcp/client 5.9.0.

- **Bump `@adcp/client` 5.8.1 → 5.9.0.** Picks up adcp-client#747 — the SDK
  storyboard runner now preserves `push_notification_config` on outbound
  requests instead of stripping it. Unblocks webhook-emission grading on
  storyboards that include the field in `sample_request`.
- **Remove `server/src/compliance/assertions/`.** 5.9.0 ships the three
  cross-step invariants (`context.no_secret_echo`,
  `idempotency.conflict_no_payload_leak`,
  `governance.denial_blocks_mutation`) as built-in defaults via
  `@adcp/client/testing`. Our local registrations would collide (SDK's
  `registerAssertion` throws on duplicate ids), so drop them and rely on
  the SDK defaults. Removes 4 source files + 1 test file.
- **Declare `push_notification_config` on `create_media_buy` inputSchema.**
  Documents what the tool accepts; survives `@adcp/client` client-side
  schema-aware field stripping post-5.9.0 fix.

Storyboard score: 39/56 → 40/56 clean (307 passing steps, up from 293).
`sales_broadcast_tv` now clean. Two new failures surfaced
(`sales_guaranteed`, `creative_generative/seller`) trace to an upstream
storyboard YAML bug (singular `scheme` vs spec-array `schemes`) filed as
adcp#2770.
