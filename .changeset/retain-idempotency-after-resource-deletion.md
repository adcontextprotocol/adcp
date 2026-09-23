---
"adcontextprotocol": minor
---

Require idempotency key ledgers to outlive created resources for the declared
replay window, and add the terminal `COMMITTED_RESOURCE_PURGED` outcome for a
write that commits before its resource is independently deleted. Ambiguous
handler or downstream timeouts now retain a fail-closed reconciliation claim
instead of freeing the key for duplicate execution, with sandbox purge/replay
coverage in the compliance controller.
