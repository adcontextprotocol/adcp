---
---

Adds an overview table to `docs/registry/index.mdx` that surfaces the three
entity-lookup endpoints (`/api/registry/agents`, `/api/registry/operator?domain=X`,
`/api/registry/publisher?domain=X`) under one roof. They live in two different
tag groups in the API reference, so the top-level docs page now spells out the
question each one answers, when to use it, and the auth-aware response-shape
note for `/operator`. Refs #3538 Problem 4 P1.
