---
"adcontextprotocol": minor
---

Wire the fourth default cross-step assertion `status.monotonic` onto the compliance specialisms that exercise lifecycle-bearing resources, and pick up the SDK implementation in [`@adcp/client@5.10.0`](https://github.com/adcontextprotocol/adcp-client/pull/760).

`status.monotonic` (adcp#2664) rejects resource status transitions observed across storyboard steps that aren't on the spec-published lifecycle graph for their resource type — catches regressions like `active → pending_creatives` on a media_buy or `approved → processing` on a creative asset that per-step `response_schema` validations can't detect. Silent on runs that don't observe any status (no steps that read lifecycle-bearing resources produce observations → no transitions → silent pass).

**Specialisms wired (20 files):**

- Sales (9): `sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`, `sales-streaming-tv`, `sales-social`, `sales-exchange`, `sales-catalog-driven`, `sales-retail-media`, `sales-proposal-mode` — media_buy lifecycle primarily; `sales-catalog-driven` also touches catalog_item.
- Creative (4 YAMLs across 3 specialisms): `creative-ad-server`, `creative-template`, `creative-generative/index.yaml` + `creative-generative/generative-seller.yaml` — creative asset lifecycle.
- Governance (4): `governance-spend-authority/index.yaml` + `denied.yaml`, `governance-delivery-monitor`, `governance-aware-seller` — media_buy lifecycle under the governance handshake. Appended to the existing `governance.denial_blocks_mutation` invariant; both run on every storyboard run in these specialisms.
- Lists (3): `property-lists`, `collection-lists`, `content-standards` — no tracked lifecycle resource in their current phases, so silent today; wired so future phases that touch `media_buy` or `account` status (e.g. validation runs against delivery) are automatically gated.

**Not wired:**

- `brand-rights`, `signal-marketplace`, `signal-owned` — no formal lifecycle enum in the spec today. No observations, no value in wiring.
- `audience-sync` — separate resource lifecycle not yet in the bundled transition tables.
- `measurement-verification`, `signed-requests` — cross-cutting / preview; revisit once phases populate.
- Sponsored intelligence (`si_session` is a tracked lifecycle) — specialism's `phases: []`, nothing to observe.

**Dep bump:** `@adcp/client` `^5.9.1 → ^5.10.0`. 5.10.0 bundles `status.monotonic` as the fourth auto-registered default assertion; the side-effect import from `@adcp/client/testing` registers it so these YAML `invariants:` ids resolve without any additional loading.
