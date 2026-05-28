---
"adcontextprotocol": patch
---

Add universal compliance coverage for the AdCP 3.1 read-tool `idempotency_key` contract.

The new `read_tool_idempotency` storyboard verifies that representative read
tasks accept the every-request envelope fields (`idempotency_key`, `context`,
and `ext`) without strict wrapper rejection, while documenting the 3.1
omitted-key grace probe that should become a required rejection in the 3.2
storyboard cut.
