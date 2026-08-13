---
"adcontextprotocol": patch
---

compliance: SHOULD-level session-lifecycle guidance for conformance runners

Adds a `session_lifecycle` block to `runner-output-contract.yaml` (per the
#6204 triage): runners SHOULD establish one MCP session per storyboard and
reuse it across that storyboard's steps, SHOULD close sessions gracefully at
storyboard end, and SHOULD treat an HTTP 404 on a known-terminated session id
as terminal rather than retryable. A fresh streamable-HTTP session per call
spends 4-5 protocol round trips on handshake alone (~5x per-step wall time,
attributed to the agent under test rather than the runner), and orphaned
GET-stream reconnects against expired sessions generate silent 4xx volume
that is easily misread as rate limiting. Guidance only — no wire or schema
change; the session-per-storyboard implementation lands in `adcp-client`.
