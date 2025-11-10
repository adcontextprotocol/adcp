---
"adcontextprotocol": minor
---

Initiator Context

All tool calls may include an optional `context` object controlled by the tool initiator.

- Purpose: carry per-call metadata. Initiators can use it for the session hints, analytical purposes, tracking usage and etc.
- Ownership: set by the client initiating the tool call; publishers must echo it back unchanged
- Echoing: returned in every protocol response envelope and in webhook payloads
- Validation: treated as opaque by agents; not validated or interpreted by the protocol
