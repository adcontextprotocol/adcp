---
"adcontextprotocol": patch
---

fix(ci): OpenAPI generator merge-preserves hand-authored registry.yaml paths

PR #4771 added 685 lines of brand-registry endpoint documentation directly to `static/openapi/registry.yaml` because those routes (brand.json, brand-logos upload/list/review, brand ownership, brand wiki, brand-logos moderator queue/preview) are docs-only — the Express routes exist but were never given Zod schemas. The TypeScript Build CI step runs `npm run build:openapi && git diff --exit-code` and treats any drift as a failure, so #4771 was merged with the freshness lint already failing on main and every subsequent PR's CI has been red on the same step.

Rather than force every adopter to wire Zod schemas before they can ship a docs change, the generator now reads the on-disk yaml and unions its tracked output with anything already there — paths, component schemas, and tag descriptors. Generator output wins on conflicts so Zod-backed paths remain the source of truth; docs-only entries (the brand-registry surface, and any future hand-authored additions) are preserved across regens.

Brand Logos and Brand Wiki tag descriptions moved into `scripts/generate-openapi.ts`'s `TAG_DESCRIPTIONS` map so they emit in their documented position (between Brand Resolution and Property Resolution) instead of getting appended to the tag list.

`static/openapi/registry.yaml` carries a 2-line whitespace normalization from the YAML library's standard re-serialization — quoted string forms collapse to unquoted where YAML permits, semantically identical.
