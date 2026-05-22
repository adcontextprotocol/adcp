---
"adcontextprotocol": patch
---

Stop posting agent/user input errors to `#admin-errors`. The MCP server catch block now distinguishes `ToolError` (expected — logged at `warn`) from genuine exceptions (logged at `error`), matching the pattern already used in `claude-client.ts`. `POST /api/registry/properties/save` and `POST /api/registry/brands/save` now pre-check `review_status === 'pending'` and return 409, parallel to the existing authoritative-source check, instead of letting the DB throw and bubble up as a 500.
