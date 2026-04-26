---
---

Refactor `workos-client.ts` to a lazy-init factory (`getWorkos()`), removing the module-load throw that broke test suites. Converts all dynamic-import workarounds back to static imports.
