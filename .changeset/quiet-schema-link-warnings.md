---
---

Schema link check only comments on PRs for actionable errors. Warnings
("schema exists in source but not yet released") now go to the workflow job
summary instead of a PR comment — they self-resolve on the next release and
were generating email noise on every schema-touching docs PR.
