---
---

ci(release): narrow forward-merge auto-resolve allowlist to metadata-only files. Content-file divergences (schemas, docs, workflow scripts) now fail the workflow loud and require human review, rather than silently dropping 3.0.x patches via whole-file `--ours` checkout. Closes #4306.
