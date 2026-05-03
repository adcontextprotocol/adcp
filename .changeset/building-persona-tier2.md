---
---

docs(building): persona-walk Tier 2 — single-source 3.0 changelog + per-layer SDK contracts

Two structural fixes from the post-merge persona walks (hand-rolled migrator, SDK porter).

**1. Single-source 2.5→3.0 L3 changelog.** The list of what 3.0 added at L3 (mandatory idempotency, lifecycle state machines, conformance test surface, RFC 9421 baseline, expanded error catalog) was repeated three times across `building/index.mdx`, `cross-cutting/sdk-stack.mdx:18`, and `cross-cutting/sdk-stack.mdx:308` — never living at a stable URL the migrator persona could share with their team.

Added a canonical **"What changed at L3 in 3.0"** section to `cross-cutting/version-adaptation.mdx`. It expands the bullet-list into proper protocol-implementer-focused content (idempotency semantics, seven lifecycle resource types, RFC 9421 baseline, async-task contract, webhook signing). The three previously-duplicated places now link to it (and to `/docs/reference/whats-new-in-v3` for the protocol-wide changelog).

**2. Per-layer SDK contract checklists inlined.** SDK porter persona walked into `by-layer/L0/index.mdx` etc. and got thin pointer stubs that punted to `cross-cutting/sdk-stack`. The actual L0/L1/L2/L3 build-target contracts lived only on sdk-stack — bookmark-worthy but not where someone scoping a port would land.

Inlined each layer's contract checklist into the corresponding landing:
- `by-layer/L0/index.mdx` — types, schema validator, transport adapters, schema-bundle accessor.
- `by-layer/L1/index.mdx` — RFC 9421 signing + verification, signing-provider abstraction, verifier-test harness.
- `by-layer/L2/index.mdx` — account-store abstraction, auth primitives, brand resolution, sandbox/live boundary.
- `by-layer/L3/index.mdx` — state machines, idempotency cache, async-task dispatcher, webhook emitter, conformance test surface, persistence primitives, server-construction entry point.

`cross-cutting/sdk-stack.mdx` still carries the cumulative cross-layer narrative; the per-layer pages now stand on their own as build-target references for porters and SDK authors. Cross-links go both directions.
