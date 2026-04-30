---
---

docs: document schema URL convention for MDX links

Adds `docs/contributing/schema-links.md` explaining that Markdown hyperlinks
to AdCP JSON schemas in `.mdx` files must use absolute
`https://adcontextprotocol.org/schemas/v3/...` URLs — bare paths like
`/schemas/enums/foo.json` fail the Mintlify broken-links checker. Documents
the released-vs-unreleased decision rule, the `$schema`-vs-hyperlink
distinction, and the two CI validators (`mintlify broken-links` and
`check-schema-links.yml`) that enforce the convention.

Also adds a one-line pointer to the new page in `CONTRIBUTING.md` and a `<Note>`
cross-link in `docs/building/schemas-and-sdks.mdx`.

Closes #3634.
