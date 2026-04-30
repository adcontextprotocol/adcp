---
title: Schema links in documentation
description: "How to link to AdCP JSON schemas from MDX documentation. Use absolute https:// URLs — bare paths fail the Mintlify link checker."
"og:title": "AdCP — Schema links in documentation"
---

# Schema links in documentation

When writing a Markdown hyperlink to an AdCP JSON schema inside an `.mdx` doc,
use an **absolute `https://` URL** — never a bare `/schemas/...` path.

The Mintlify broken-links checker (`mintlify broken-links`) validates links
against pages in the docs site. Bare `/schemas/...` paths are not Mintlify
pages; they are external artifacts served from `adcontextprotocol.org`. A bare
path silently fails the checker with an unhelpful error:

```
found N broken links in N files
docs/your-file.mdx
 ⎿  /schemas/enums/viewability-standard.json
```

## Which URL to use

### Released schemas

Use the major version alias (`v3`) for schemas that exist in a released version
under `dist/schemas/`:

```markdown
[`viewability-standard.json`](https://adcontextprotocol.org/schemas/v3/enums/viewability-standard.json)
```

**How to check if a schema is released:** look for it under the highest
version directory for your major in `dist/schemas/` (e.g., `dist/schemas/3.0.1/`
for v3). If it exists there, the schema is released — use the `/schemas/v3/` alias.

### Unreleased schemas

For schemas that exist only in `static/schemas/source/` (not yet in any
`dist/schemas/` version), use the absolute URL with `/schemas/latest/` and
include a comment so the link gets updated after the next release:

```markdown
<!-- Using /schemas/latest/: this schema is not yet in a released version.
     Update to /schemas/v3/ after the next release. -->
[`account-authorization.json`](https://adcontextprotocol.org/schemas/latest/core/account-authorization.json)
```

The `check-schema-links.yml` CI workflow flags stray `/schemas/latest/`
references in docs so they do not accumulate after a release ships.

## Version aliases

| Alias | Resolves to |
|---|---|
| `/schemas/v3/` | Latest 3.x release |
| `/schemas/v2/` | Latest 2.x release |
| `/schemas/latest/` | Development version (`static/schemas/source/`) |

## Common mistakes

| Instead of... | Use... |
|---|---|
| `/schemas/enums/foo.json` | `https://adcontextprotocol.org/schemas/v3/enums/foo.json` |
| `/schemas/latest/foo.json` (in stable docs) | `https://adcontextprotocol.org/schemas/v3/foo.json` |
| `https://adcontextprotocol.org/schemas/v2/foo.json` in v3 docs | `https://adcontextprotocol.org/schemas/v3/foo.json` |

## `$schema` fields vs. Markdown links

This rule applies **only to Markdown hyperlinks** you write in `.mdx` files.
It does **not** apply to `$schema` fields inside JSON code blocks:

```json
{
  "$schema": "/schemas/v3/core/product.json"
}
```

`$schema` values in JSON examples use bare paths intentionally — the dev server
resolves them locally. These paths are not scanned by the Mintlify link checker.

## CI checks that enforce this

Two separate validators apply to schema URL references in docs:

| Check | Trigger | What it catches |
|---|---|---|
| `mintlify broken-links` (pre-push + `broken-links.yml` CI) | Every push that touches docs | Bare `/schemas/...` paths in Markdown links |
| `check-schema-links.yml` CI | PRs touching `docs/**/*.mdx` | Stale old-version aliases (`/schemas/v2/` in v3-era docs) and stray `/schemas/latest/` references |

Both checks can fail independently on the same PR. If you fix one and see a
new error, check the other.

For the versioning model behind these aliases, see
[Schemas and SDKs](/docs/building/schemas-and-sdks#schema-versioning).
