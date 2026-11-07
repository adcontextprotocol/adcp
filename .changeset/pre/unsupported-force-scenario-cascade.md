---
"adcontextprotocol": patch
---

Clarify that unsupported stateful test-controller forcing skips its dependent observations as unavailable coverage, including when forcing is the only stateful step in its phase. Preserve independent coverage and genuine failures without dispatching observations against state the controller never established.
