---
"adcontextprotocol": patch
---

Compliance: add `version-translation` test vectors for cross-version translation between consecutive minor releases (proposed DR-0032 / DR-0033, aligned with DR-0036), one file per pair: `3.2-3.1.json` and `3.3-3.2.json` (settled surfaces, provisional until 3.3 GA). They cover client request down-conversion and response up-conversion, server response down-conversion, refusal of mutations whose lost field would change the commitment, exact field moves, envelope fields kept, release negotiation, and one-to-one reduction of the 3.2 account key.
