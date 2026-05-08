---
---

ci(release): forward-merge auto-resolves `storyboard-schema.yaml` on 3.0.x

Backports the `.github/workflows/forward-merge-3.0.yml` allowlist update from #4229 — the workflow runs from the pushed branch, so 3.0.x needs its own copy. Promotes `static/compliance/source/universal/storyboard-schema.yaml` to the 3.1-track-divergence allowlist with `--ours` (keep main's superset), unsticking the post-Version-Packages forward-merge that's been failing since the storyboard-schema divergence emerged.

Verified manually on PRs #3902 (3.0.5), the unmerged 3.0.6 forward-merge attempts, #4225 (3.0.7), and the 3.0.8 cut. Workflow file is taken verbatim from main's #4229; no other surface changes.
