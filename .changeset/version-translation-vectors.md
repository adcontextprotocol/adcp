---
"adcontextprotocol": patch
---

Compliance: add `version-translation` test vectors for cross-version translation between consecutive minor releases (proposed DR-0032 / DR-0033). They cover client request down-conversion and response up-conversion, server response down-conversion, refusal of lossy mutations, exact field moves, release negotiation, and one-to-one account-key reduction, starting with 3.2 ↔ 3.1.
