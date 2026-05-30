---
"adcontextprotocol": minor
---

Fix release validation for compliance bundle closure and align signals conformance with the owned-signal manifest fix tracked in #5186.

- Package webhook receiver envelope vectors under the versioned compliance tree and update storyboard references to bundle-relative paths.
- Fail compliance and protocol tarball builds when authored vector/test-kit references do not resolve inside the packaged compliance tree.
- Narrow baseline and `signal_owned` conformance back to discovery-only so SDK manifests do not require owned-signal agents to implement marketplace activation.
- Require `activate_signal` on the `signal_marketplace` specialism and update the Signals Protocol docs to state the two-tier obligation explicitly.
