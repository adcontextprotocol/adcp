---
"adcontextprotocol": patch
---

fix(schema): reconcile $ref sandbox host in product-format-declaration (closes #4862)

`core/product-format-declaration.json#format_schema.description` contained two conflicting normative statements: the `v1_format_ref` mirror-domain migration block (labeled "3.1") says `creative.adcontextprotocol.org/translated/` is the canonical AAO mirror host and that adopters MUST migrate away from the legacy host; the `$ref` sandboxing clause in the same description still named `mirror.adcontextprotocol.org` as the allowed non-same-origin anchor, causing strict implementations of the sandbox to silently reject `$ref`s hosted under the correct domain.

**Changes:**

- `core/product-format-declaration.json` `format_schema.description` — two edits:
  1. **Sandboxing of `$ref` bullet:** `(b) hosted under the AAO mirror namespace (\`https://mirror.adcontextprotocol.org/...\`)` → `(b) hosted under the AAO catalog domain (\`https://creative.adcontextprotocol.org/...\`)`
  2. **AAO mirror trust bullet (end of description):** rename to "AAO catalog trust", replace `mirror.adcontextprotocol.org/*` with `creative.adcontextprotocol.org/*`, update surrounding prose to match.
- `docs/creative/canonical-formats.mdx` `$ref` sandboxing rule (item b) and "AAO mirror" trust anchor note updated to name `creative.adcontextprotocol.org` and use "AAO catalog domain" terminology.

No structural schema changes. No new fields, enum values, or MUST requirements — this is a normative-text consistency repair. `mirror.adcontextprotocol.org` was never provisioned; `@adcp/sdk` 7.10 already ships both hosts in `DEFAULT_MIRROR_HOSTS` as a transitional posture and can drop the legacy entry on next release.

Closes #4862.
