---
---

Dependencies: maintenance pass — bump anthropic SDK 0.91→0.96, @opentelemetry/*-logs 0.215→0.218, undici 7→8, typescript 5.9→6.0, axios 1.13→1.16 (closes prototype-pollution + NO_PROXY CVEs), @google-cloud/kms 5.4→5.5, mintlify 4.2.531→4.2.563. Dropped deprecated `@types/dompurify` stub. Took all in-range patches via `npm update`. Audit: 11 vulns (2 mod / 9 high) → 5 high, all in the mintlify→tar devDep chain (no runtime exposure).
