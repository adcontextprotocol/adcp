---
---

New `docs/building/verification/storyboards-vs-scenarios.mdx` disambiguating three things in AdCP that share the word "scenarios" and aren't the same: (1) **storyboards** — YAML, normative, the conformance specification; (2) **`comply_test_controller` scenarios** — protocol-level tool operations (`force_*` / `simulate_*` / `seed_*`); (3) **`@adcp/sdk/testing/scenarios/*.ts`** — legacy non-normative SDK test runners that predate `comply()`. Closes the docs half of #4035; the SDK packaging/CLI side (deprecation marker, mirrored CLI verbs, internal-only export) lives in `adcp-client`. Cross-linked from `conformance.mdx` and `validate-your-agent.mdx` callouts so readers grepping `testing/scenarios/*.ts` to learn the spec get redirected to storyboards.
