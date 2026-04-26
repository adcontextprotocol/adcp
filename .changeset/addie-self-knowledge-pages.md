---
---

Addie now has self-knowledge documentation. Adds three audience-specific pages under `docs/aao/` (members, org-admins, AAO-admins) plus an auto-generated tool reference (`addie-tools.mdx`) listing all 224 of Addie's tools grouped by capability set. search_docs indexes these automatically, so Addie can answer "what can you do?" or "how do I do X on AAO?" by reading her own reference instead of fabricating. Generator is `scripts/build-addie-tool-reference.ts`; `npm run test:addie-tools` is a parity check that fails CI if the page is stale.
