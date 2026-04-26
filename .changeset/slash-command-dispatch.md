---
---

Migrate the manual triage nudge to `peter-evans/slash-command-dispatch`. Command is now `/triage [execute|clarify|defer]` (no more `@claude-triage` which collides with the `@claude` GitHub App autocomplete). Benefits: reactions on the triggering comment (👀 on ack, +1 on success, -1 on failure), clean separation between dispatcher and handler, extensible to future commands (`/rebase`, `/retest`, `/autofix`).

Requires one new repo secret: `TRIAGE_DISPATCH_PAT` (PAT with `contents:write` + `issues:write` + `pull-requests:write` on the repo; GITHUB_TOKEN cannot fire `repository_dispatch`).
