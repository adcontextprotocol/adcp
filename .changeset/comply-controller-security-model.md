---
---

docs: add Security model section to comply_test_controller, frame the threat model and Stripe precedent, make sandbox-account properties (set-at-creation, immutable, isolated billing, no real delivery, no real PII) normative, and cross-link from `docs/building/implementation/security.mdx` and `docs/contributing/storyboard-authoring.md`. Addresses partner pushback that the controller is a production backdoor — the controller rides the seller's existing tenancy gate rather than widening it; this PR documents the gate, not the tool.
