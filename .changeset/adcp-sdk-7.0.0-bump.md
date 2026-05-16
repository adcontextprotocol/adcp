---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` from `^6.19.1` to `^7.0.0`.

7.0.0 ships the SDK-side fixes for five compliance-harness issues we filed against `adcp-client` ([#1676](https://github.com/adcontextprotocol/adcp-client/issues/1676) – [#1680](https://github.com/adcontextprotocol/adcp-client/issues/1680)) after probing Wonderstruck against the AAO conformance suite:

- `request-normalizer` no longer fabricates `account` from `brand.domain` on `create_media_buy` — missing `account` now throws `ValidationError` at the client boundary, per the AdCP 3.0 spec and the v2 sunset policy (#1676).
- `PackageRequest` normalizer throws on the pre-3.0 `product_ids: string[]` and `budget: {total, currency}` shapes — there's no safe translation for these (which id wins? which currency?) so it fails closed (#1677).
- Webhook storyboards skip cleanly when no `webhook_receiver` is configured instead of sending a relative `push_notification_config.url` and false-failing (#1678).
- `ComplianceResult.failures[]` now carries the structured `adcp_error` payload + `validation` detail, so heartbeat output reveals real wire-level failures instead of dropping to `error: {}` (#1679).
- Storyboards whose `required_tools` aren't all present in the agent's discovered toolset are graded `not_applicable` at the storyboard level, surfaced via `storyboards_missing_tools` / `storyboards_not_applicable` on the result root — they no longer cascade `partial` to the track (#1680).

Net effect for AAO heartbeat output: false-positive passes go away (no more badges issued against fabricated-account requests), false-negative track drops go away (controller-dependent storyboards on agents that don't expose controller stop dragging unrelated tracks to `partial`), and failures become diagnosable from the heartbeat alone instead of needing a separate SDK-level probe.

Typecheck clean, 873/873 unit tests pass on 7.0.0.
