---
---

spec(webhooks): strengthen HMAC test vectors against production copy-paste

The legacy HMAC test vectors shipped a human-readable 42-character ASCII
secret (`test-secret-key-minimum-32-characters-long`) that was trivially
copyable into production `.env` files and integration tests. The vectors
also lacked any negative case for sub-32-byte or zero-entropy secrets, so
implementations could ship without a weak-secret check and still pass
conformance.

Replaces the secret with a 64-hex (256-bit) value derived deterministically
from `SHA-256("adcp-webhook-hmac-test-vector-v1-DO-NOT-USE-IN-PRODUCTION")`,
adds a top-level `WARNING` field making the non-production status
unambiguous, documents the preimage, and adds a new `secret_rejection_vectors`
block covering sub-32-byte, empty, all-zero, and repeating-ASCII secrets.
Recomputes every positive-vector signature under the new key and updates
the tampered-body rejection vector accordingly. Bumps `version` to 2.
