---
---

docs(building): SDK stack reference + decision page + version-adaptation guide + hand-rolled migration guide

Adds four pages to docs/building/ that orient adopters around how much of L0–L3 they inherit from an AdCP SDK vs. write themselves. Targets two recurring wrong conclusions:

1. Early implementers who built before the SDKs were mature and have a frozen-in-time picture of "what an SDK does" — most of L3 (state machines, idempotency, conformance test surface, RFC 9421, expanded error catalog) was added with AdCP 3.0.
2. New implementers who treat AdCP as a thin protocol and don't see the L0–L3 scope.

New pages:

- `docs/building/sdk-stack.mdx` — full L0–L4 reference: layers, what an SDK at each layer should provide, version-adaptation summary, per-component cost decomposition, "what early implementers underestimate" punch list, and the live SDK coverage matrix (`@adcp/sdk` 6.7.0 GA, Python `adcp` 4.x in flight, `adcp-go` in dev).
- `docs/building/where-to-start.mdx` — short decision page. Three questions, recommended path for ~95% of adopters, "what you give up by going lower" cost table.
- `docs/building/version-adaptation.mdx` — three-mechanism reference: per-call `adcpVersion` pinning, SDK-major co-existence imports, on-wire `supported_versions` + `VERSION_UNSUPPORTED` envelope + typed pre-flight throw.
- `docs/building/migrate-from-hand-rolled.mdx` — eight-section incremental migration guide: inventory, spec-compliance-first, lowest-risk swap order, six conflict modes (idempotency, account-mode, webhook signing, state-machine drift, webhook transport, schema validation), intermediate-conformance states, per-step rollback playbook + 2 a.m. recipe, multi-buyer worked example, what-you-can-leave-hand-rolled, version drift, when-not-to-migrate.

Wiring: docs.json nav (both occurrences) and docs/building/index.mdx Quick Start now route through the decision page.

Cross-links into existing spec pages: lifecycle, idempotency, error handling, RFC 9421 implementation, comply_test_controller, conformance, sandbox, versioning.

Reviewed in flight by DX and docs experts; persona-tested by three builder archetypes (early SSP implementer, greenfield startup builder, SSP product manager) — verdicts: EVALUATE → ADOPT (pilot), ADOPT (conviction tightened), EVALUATE FURTHER → GO to pilot.
