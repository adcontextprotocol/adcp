---
"adcontextprotocol": patch
---

Controller-seed canonical test-kit account prerequisites before account-scoped
storyboard steps run, using deterministic per-storyboard operator units to keep
account state isolated. This prevents missing or leaked setup from being
misgraded as failures of the tools those steps exercise. The reference training
agent now accepts those account fixtures on every applicable tenant and lets
framework task settlement emit terminal webhooks before controller completion
returns. Refs #7588.
