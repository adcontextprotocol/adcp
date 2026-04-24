---
---

Fix Mintlify broken-links check failure introduced by #3011. IPR_POLICY.md §8 linked to `./signatures/README.md` and `./signatures/ipr-signatures.json` via relative paths; Mintlify's checker treats those as broken because the targets aren't in the docs tree it validates. Switch to absolute github.com URLs (same pattern used for IPR_POLICY itself in CONTRIBUTING.md). Unblocks docs-path-touching PRs from failing the `broken-links` workflow.
