---
"adcontextprotocol": patch
---

compliance: the multi-agent governance storyboards (`media_buy_seller/governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery`, and the brand-rights, signal-marketplace, and creative-transformers `governance_approved` storyboards) now use the buyer brand `hosted-grader.adcontextprotocol.org` instead of `acmeoutdoor.example`, and a new `test-kits/hosted-grader.yaml` test kit declares it. The authored intent-check `caller` is now `https://hosted-grader.adcontextprotocol.org/buyer` instead of `https://pinnacle-agency.example`.

A `.example` brand has no resolvable `brand.json`. A seller following the signed governance context checklist therefore could not confirm the token issuer against the buyer's `brand.json` (step 13) or discover the governance keys. The new AgenticAdvertising.org-controlled domain serves a `brand.json` that lists the sandbox governance agent with a governance-only `jwks_uri`; that deploys with the hosted-grading server change.

The fixed `caller` is the buyer agent that hosted grading authenticates as on the sandbox governance agent. A seller maps the credential it gives hosted grading to that buyer agent and brand, so the seller's authenticated caller matches the token `caller`.

Steps, validations, and grading are unchanged. No normative change. Refs #7758.
