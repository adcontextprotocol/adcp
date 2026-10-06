---
"adcontextprotocol": patch
---

Backport the hosted-grader buyer brand from #7803 to the four 3.1 media-buy governance scenarios. The scenarios and their new sandbox test kit consistently use `hosted-grader.adcontextprotocol.org`, whose brand.json lists the sandbox governance agent and its governance-only JWKS. This allows hosted multi-agent routing to register the same buyer account and governance relationship that it authenticates.

Only buyer/test-kit identities change; the existing 3.1 steps, schemas, validations, and grading behavior remain unchanged. Published release artifacts are preserved. Refs #7758.
