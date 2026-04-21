---
---

docs(storyboards): document the two test-kit flavors and the runner-kit composition pattern — closes #2721.

#2721 was filed from protocol review of the #2708/#2711 resolved-auth fingerprint PR, worrying that three test kits under `static/compliance/source/test-kits/` (`signed-requests-runner`, `substitution-observer-runner`, `webhook-receiver-runner`) have no `auth:` block — so a storyboard that composed a runner kit with a brand kit would produce an ambiguous `auth=kit_default` in the contradiction lint's env fingerprint. The issue offered three schema changes (Option A single-kit constraint + separate coordination field, B array form, C distinct top-level `coordination:` field).

Investigation surfaced that **none of the three options are needed**. The composition pattern already exists:

- **Brand kits** (5 today: acme-outdoor, bistro-oranje, nova-motors, osei-natural, summit-foods) carry `auth.api_key` and identify a principal. Pure-brand storyboards point `prerequisites.test_kit` here.
- **Runner contracts** (3 today: signed-requests-runner, substitution-observer-runner, webhook-receiver-runner) carry `applies_to:` metadata and harness-coordination fields. No credentials. Pure-harness storyboards (e.g., `specialisms/signed-requests/index.yaml`, `universal/webhook-emission.yaml`) point `prerequisites.test_kit` directly here and use `task_default:` when `$test_kit.operations.<name>` references resolve to null.
- **Composition** is done at the step level via `requires_contract:` on the specific assertion tasks that need it (`expect_substitution_safe`, `expect_webhook*`). `specialisms/sales-catalog-driven/index.yaml` and `specialisms/creative-generative/index.yaml` already use this pattern: they declare a brand kit in `prerequisites.test_kit` and opt into the substitution-observer contract per-step.

The `auth=kit_default` ambiguity the issue feared can't actually arise because `prerequisites.test_kit` is always a single path and `test_kit=<path>` in the fingerprint discriminates between brand kits (where `kit_default` resolves to the kit's api_key) and runner contracts (where `kit_default` unambiguously means "no credentials sent").

This PR:

- Adds a "Test kit flavors" section to `static/compliance/source/universal/storyboard-schema.yaml` formalizing the bimodal partition, the composition seam, and a future note that two-runner-contract composition would require `requires_contract:` to accept a list (not reachable today).
- Clarifies the `prerequisites.test_kit` field description to explicitly state the single-path invariant.
- Adds a small enforcement lint (`scripts/lint-storyboard-test-kits.cjs`) that fails the build when a file under `test-kits/` declares neither `auth.api_key` nor `applies_to` — without the lint the docs would describe an invariant that isn't mechanically checked, and a future orphan kit would silently reintroduce the `auth=kit_default` ambiguity #2721 was filed to close.
- Wires the lint into `build:compliance` and the aggregate `npm test` script alongside its siblings.

Resolves the issue's earlier note that osei-natural "may have auth — verify": it does (`demo-osei-natural-v1`).
