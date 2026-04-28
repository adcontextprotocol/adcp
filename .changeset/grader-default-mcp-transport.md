---
---

`grade_agent_signing` now passes `--transport mcp` to the underlying CLI grader by default and exposes a `transport` parameter (`mcp` | `raw`) on the tool. The CLI's own default is `raw`, which posts to per-operation AdCP endpoints — wrong for AdCP MCP servers (every probe gets 404). Validated against the local training agent: 31 vectors pass with `--transport mcp`, all return 404 with the CLI default.

Operators with a raw HTTP AdCP surface can pass `transport: 'raw'`. Closes the second half of the demo path on top of #3421 (CSRF) and #3397 (the wrapper itself).
