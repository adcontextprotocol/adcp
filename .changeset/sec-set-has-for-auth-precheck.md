---
---

Update the two-step auth-precheck code example in `docs/building/implementation/security.mdx` to use `Set.has()` instead of `Array.includes()` on `authorizedAccountIds`. Reasons inlined as a comment: `Set.has()` is O(1) while `Array.includes()` is O(n) and introduces a measurable timing difference across requests for large authorized-account sets. Extracted from PR #2433.
