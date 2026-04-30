---
---

Two fixes for Addie's GitHub Connect flow that re-surfaced after #3700 deployed. (1) `wrapUrlsForSlack` now stops the URL match at `*`/`"`/`'` so a model-emitted `**URL**` produces `**<URL>**` (Slack-explicit-link wrapper around just the URL) rather than `<URL**>` (asterisks swallowed into the link target — the production 404 root cause). Deterministic — doesn't depend on prompt compliance. (2) New constraint in `constraints.md` ("Never Claim Tools Are Unavailable Without Checking") with the GitHub-flow example, since the existing `behaviors.md` rule lives before dynamic context and bound less tightly than needed; constraints load last so the prohibition is more salient.
