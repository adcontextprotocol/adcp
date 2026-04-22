---
---

Regenerate webhook-signing negative vector 016-replayed-nonce with a 16-byte nonce so it survives the step-2 params check and reaches the step-12 replay assertion on spec-compliant verifiers. Prior nonce `REPLAYED_________A` decoded to ~13 bytes, below the AdCP RFC 9421 profile's 16-byte minimum, causing conformant verifiers to reject with `webhook_signature_params_incomplete` before the replay check could fire. Closes #2750.
