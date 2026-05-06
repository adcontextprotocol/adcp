---
---

fix(spec): quote MemberProfile.primary_brand_domain description so Mintlify can parse the OpenAPI

The description was authored as an unquoted plain YAML scalar containing both `\"public\"` (backslash escapes that only have meaning inside a double-quoted scalar) and `: ` (colon-space, a YAML key/value separator). Mintlify's OpenAPI extractor errors with `bad indentation of a mapping entry (1905:178)` and silently gives up on the whole file. With no parsed OpenAPI, every `/docs/registry/api-reference/<tag>/<op>` link in the prose docs reports as broken — cascading into ~10 false-positive broken-link reports any time `.husky/pre-push` triggers the Mintlify scan.

Fix: quote the description and drop the now-unnecessary backslash escapes by writing `visibility: public` plainly inside the backtick code span. No content change.

**Why now:** `.husky/pre-push` only runs the broken-links scan when a branch's diff range includes a `DOC_PATHS`-matching file. Branches that don't touch docs/addie/Mintlify configs silently skip it; `main` itself never runs the hook on push. A recent feature branch rebased against a `main` with `server/src/addie/mcp/*.ts` churn, expanded its diff range, and tripped the hook for the first time — surfacing this latent parse error.

**Followups worth filing separately:**

- `.husky/pre-push` should diff against `origin/main`, not `@{u}` — so a rebase doesn't expand the trigger surface to include unrelated commits already on `main`.
- CI should run `mintlify broken-links` on `main` so latent docs breakage doesn't accumulate.
- `static/openapi/registry.yaml` is partially hand-edited (PR #4130's `/api/me/member-profile` paths and Member* schemas are not in Zod source) and partially regenerated. Running `npm run build:openapi` against current Zod source produces a YAML where the `lookupDomain` operation summary is `Domain lookup (deprecated)` (Zod source) instead of `Domain lookup` (current YAML). Picking one source of truth would close the drift.
