---
---

`forward-merge-3.0.yml`: push the `forward-merge/3.0.x` branch to origin **before** `peter-evans/create-pull-request@v8` runs. Discovered when 3.0.4's forward-merge ran for real for the first time — auto-resolution succeeded ("Auto-resolution complete", `skip=false`), then peter-evans failed with `fatal: ambiguous argument 'origin/forward-merge/3.0.x': unknown revision or path not in the working tree`.

The action's internal `git reset --hard origin/forward-merge/3.0.x` step assumes the remote-tracking branch exists. On a first run (or after a stuck-PR cleanup that deleted the remote branch), it doesn't. Adding an explicit `git push --force origin HEAD:refs/heads/forward-merge/3.0.x` after the merge resolution establishes the remote ref so peter-evans's reset has somewhere to point.

This was the last gap in the auto-resolution chain — with this in place, 3.0.4 (and every subsequent VP cut) auto-creates the forward-merge PR without human intervention.
