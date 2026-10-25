---
"adcontextprotocol": patch
---

Experimental demand-side grants: L2 §Grants in trust records replaces the three enumerated grant-chain forms with one delegation-chain rule. A delegation chain has at most two grants, from the parent organization to the signer's operator. The second grant comes from its grantor's own trust.json. `account.operator` MUST be the brand, the parent organization, or the grantee of the first grant. The rule covers a parent organization that operates its account through a hosted agent, which the enumerated forms missed. It also admits the brand or the parent organization as `account.operator` on a two-grant chain. Spec R6, the production security profile, the trust.json page, and the `grant` requirement kind use the term "delegation chain". New conformance vectors in `static/test-vectors/delegation-chains.json` cover the rule, and `tests/delegation-chain-vectors.test.cjs` asserts them with a reference evaluator. Schemas change in description text only.
