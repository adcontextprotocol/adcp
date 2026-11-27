---
"adcontextprotocol": patch
---

Make each branch of two either/or unions refuse the other branch's key: `core/evaluator-spec.json` (`exemplars` or `agent_url`) and the `v1_pattern` of `registries/v1-canonical-mapping.json` (`format_id_glob` or `structural`). A payload carrying both keys was already invalid when both forms were valid. It is now also invalid when the second form is malformed. (#9051)
