---
"adcontextprotocol": minor
---

Fix the vendor-scope qualifier on `delivery-metric-aggregate` (previously a closed object with no properties, so only `{}` could validate) and add the optional 5-key qualifier to the vendor branches of `committed-metric` and `missing-metric`, matching what `canonical-reporting-commitment` already allows — vendor metrics measured under different attribution windows or methodologies are now distinguishable on the contract and reconciliation surfaces. A qualifier parity contract test now enforces an identical closed key set across every hand-maintained copy.
