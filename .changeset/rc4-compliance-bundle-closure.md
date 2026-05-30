---
"adcontextprotocol": patch
---

Fix release validation for compliance bundle closure and remove `activate_signal` from the owned-signal specialism.

- Package webhook receiver envelope vectors under the versioned compliance tree and update storyboard references to bundle-relative paths.
- Fail compliance and protocol tarball builds when authored vector/test-kit references do not resolve inside the packaged compliance tree.
- Narrow `signal_owned` conformance back to discovery-only so SDK manifests do not require owned-signal agents to implement marketplace activation.
