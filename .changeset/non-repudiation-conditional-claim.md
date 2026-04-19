---
---

docs(security-model): replace non-repudiation overclaim with conditional claim

The prior wording asserted that "a buyer cannot later claim a plan was
never approved, and a seller cannot later claim an approval was never
received" as if it were an unconditional protocol guarantee. Both halves
are only conditionally true:

- The buyer-side claim depends on the signing key being uncompromised at
  time-of-signing; the revocation timeline bounds that, but the claim
  should be stated as conditional rather than absolute.
- The seller-side claim is weaker — an attestation proves the plan
  existed, not that it was delivered or acknowledged. "Never received"
  remains deniable without a signed receipt artifact.

Rewords the bullet to state the conditional claim accurately and flags
`plan_receipt` as the missing bilateral-non-repudiation artifact. No
normative changes; the text now matches what the cryptography actually
delivers and what a hostile auditor would accept.
