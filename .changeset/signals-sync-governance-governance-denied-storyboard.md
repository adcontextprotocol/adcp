---
---

Register `sync_governance` on the `/signals` training-agent tenant and add `activate_signal` to `ERROR_IN_BODY_TOOLS`.

The `/signals` tenant previously had no `sync_governance` tool, causing the `signal_marketplace/governance_denied` compliance storyboard to skip all four steps (1P/4S). This change adds `sync_governance` via `serverOptions.customTools` using the same pattern as `creative_approval` on `/brand`, and wires `activate_signal` into `ERROR_IN_BODY_TOOLS` so `GOVERNANCE_DENIED` responses surface in the response body for storyboard `error_code` and `field_present` validations. Session-sharing by `brand.domain` propagates governance plans from `/governance` to `/signals` without any additional HTTP calls, lifting storyboard coverage from 1P/4S to 1P/0S (+4 steps).

Refs #4094.
