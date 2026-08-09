---
"adcontextprotocol": patch
---

Modernize the package build and release toolchain to Node.js 24 and the native TypeScript 7 compiler while retaining a TypeScript 6 API package for documentation-tool compatibility. Generated declarations now preserve the inferred `string | undefined` type for the optional storyboard-runner tenant path, and CI exercises the complete canonical test manifest in parallel shards.
