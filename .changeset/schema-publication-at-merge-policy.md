---
---

Document the schema publication invariant: the `/schemas/v3/` alias tag and source HEAD must always agree on all required fields. Adds a "Schema publication at merge" subsection to `docs/reference/versioning.mdx` covering when to cut a new tag (any PR that changes a `required` array, discriminator `const`, or validation constraint), how this applies during RC cycles, and who is responsible until a CI check enforces the invariant.
