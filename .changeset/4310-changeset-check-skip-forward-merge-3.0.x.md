---
---

ci(changeset-check): backport `forward-merge/*` skip rule to 3.0.x. Mirrors #4315 + #4316 on main. Forward-merge PRs targeting 3.0.x (rare but possible — e.g., a 2.6.x → 3.0.x line in the future) will now skip the changeset check the same way main does.
