---
---

Storyboard scoping lint: every step that invokes a tenant-scoped task must carry `brand.domain`, `account.brand.domain`, `account.account_id`, or `plans[*].brand.domain` in its `sample_request`. Wired into `npm run build:compliance` so missing identity fails the build. Prevents the class of bug that #2236 exposed — a `create_media_buy` step writing to session `open:acmeoutdoor.example` while its follow-up `get_media_buys` step omits brand and lands in `open:default`.

Fixes 47 existing violations across 15 storyboards discovered by the new lint: 40 session-scoped steps get the matching `brand` added, and 7 negative/schema-validation probes in `universal/error-compliance.yaml` + `universal/schema-validation.yaml` get a `scoping: global` opt-out marker. See `docs/contributing/storyboard-authoring.md` for the authoring convention.

Closes #2527. Follow-ups filed: #2529 (parity test between handler dispatch and lint task sets), #2530 (normalize brand domains to RFC 2606 `.example`), #2531 (training-agent `sessionKeyFromArgs` fallback to `plans[*].brand.domain` for `sync_plans`).
