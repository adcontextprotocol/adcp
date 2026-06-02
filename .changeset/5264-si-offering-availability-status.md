---
"adcontextprotocol": patch
---

Add an optional `availability_status` enum to the `si_get_offering` response. It appears on the `offering` object (alongside `expires_at`) and on each `matching_products[]` item (alongside the free-string `availability_summary`), and is defined by a new centralized enum `enums/offering-availability-status.json` (`available`, `limited`, `sold_out`, `expired`, `region_restricted`, `inactive`).

The value set deliberately matches the SI task page's existing "Unavailable Reasons" vocabulary so the structured enum and the free-string `unavailable_reason` stay coherent. The field is optional and additive: it is not in `required`, both objects already carry `additionalProperties: true`, and the schema is `x-status: experimental`, so existing producers and consumers are unaffected.

Refs #5264.
