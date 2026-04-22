---
"adcontextprotocol": patch
---

Extract the inline audience-status enum on `sync_audiences_response.audiences[].status` into a named schema `/schemas/enums/audience-status.json`, matching the pattern used by `media-buy-status.json`, `creative-status.json`, `catalog-item-status.json`, `proposal-status.json`, etc.

Values are unchanged (`processing`, `ready`, `too_small`). The new enum file formalizes the existing descriptions and, in the process, documents the lifecycle transitions in prose on each `enumDescription`: `processing → ready | too_small` on matching completion; `ready ↔ processing` and `too_small → processing` on re-sync; `ready ↔ too_small` as member counts cross the platform minimum; delete/fail actions omit `status` entirely.

Motivation: enables the `audience-sync` specialism to be wired into the bundled `status.monotonic` cross-step assertion in a follow-up — today it's the highest-volume mutating track outside sales without a formal lifecycle enum (surfaced during expert review on [adcp#2829](https://github.com/adcontextprotocol/adcp/pull/2829)). Adding the audience transition graph to `@adcp/client`'s `default-invariants` is a separate adcp-client PR once this lands and publishes; wiring `audience-sync/index.yaml` with `invariants: [status.monotonic]` is a follow-up adcp PR after that SDK release.

No behavior change on the wire — `sync_audiences` responses that were valid before are valid after.
