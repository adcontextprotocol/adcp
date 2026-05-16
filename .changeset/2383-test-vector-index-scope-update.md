---
---

docs(test-vectors): reframe "Planned coverage" as "Scope" after #2383 close

#2383 (task-level test vectors) closed as redundant with storyboards + schemas + existing signing/canonicalization vectors. The index page's "Planned coverage" section promised work that won't happen. Reframe as "Scope" — explains why per-task request/response fixtures are intentionally not published (would drift against the storyboards they'd duplicate), and points SDK authors who want machine-readable fixtures at the storyboard tree.
