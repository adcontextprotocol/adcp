---
---

chore(gitguardian): whitelist webhook HMAC test-vector secret

Unblocks the high-entropy webhook HMAC test-vector secret at
`static/test-vectors/webhook-hmac-sha256.json` from GitGuardian's
generic-high-entropy detector. The secret is deterministically derived
from a documented preimage and the test-vector file carries explicit
WARNING + `secret_provenance` fields documenting non-production status.
