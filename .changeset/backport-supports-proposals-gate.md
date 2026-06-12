---
"adcontextprotocol": patch
---

Backport the proposal-finalize storyboard gate to 3.0.x so sellers that do not declare `media_buy.supports_proposals: true` skip the proposal lifecycle scenario instead of receiving false-negative compliance failures, and refresh the idempotency storyboard flight dates so the 3.0.x runner preserves byte-identical replay payloads.
