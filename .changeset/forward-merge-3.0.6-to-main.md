---
---

forward-merge: 3.0.x → main after 3.0.6 cut

Brings 3.0.x's 3.0.6 release artifacts (CHANGELOG entry, `dist/compliance/3.0.6/` bundle, package.json bookkeeping) onto main, plus adds the `## Version 3.0.6` section to `docs/reference/release-notes.mdx`.

No protocol surface change on main — every spec source 3.0.6 touched already had main equivalents (governance wire-placement #3929, ctx_metadata reservation #3640, task_completion. prefix docs #3955, comply_test_controller deployment-scope #3992, fixture fixes #3989/#3990). The conflicts auto-resolved against main were textual (main extends each surface beyond 3.0.x's shape); --ours preserved main's 3.1-track superset.

Empty changeset — forward-merge bookkeeping; no version bump.
