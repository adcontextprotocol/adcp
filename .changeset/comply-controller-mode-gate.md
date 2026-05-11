---
"adcontextprotocol": patch
---

Add `comply_controller_mode_gate` universal storyboard and `acme-outdoor-live` test kit.

New storyboard exercises the live-account denial path for `comply_test_controller`:
a seller that exposes the controller must return `FORBIDDEN` when called by a
live-mode (non-sandbox) principal. Optional phase for two-deployment sellers;
required for single-endpoint sellers that implement per-account gating.
Closes #4028.
