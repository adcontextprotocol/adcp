---
"adcontextprotocol": minor
---

Decouple signing-key discovery from the size of the full capabilities document (#8198). `get_adcp_capabilities` gains an optional request field `scope` (`full` by default, or `signing_discovery`). A verifier on the RFC 9421 signing-key discovery path now sends `scope: "signing_discovery"`, and an agent that declares any signing posture returns only `adcp` (`major_versions`, `idempotency`), `supported_protocols`, `identity`, `request_signing`, and `webhook_signing`. A large `creative.supported_formats` catalog therefore no longer pushes the fetch past `MAX_CAPABILITIES_BYTES` (unchanged at 64 KiB) and makes the agent's own signing keys unresolvable. The field is additive: a 3.2 agent ignores it and a 3.2 verifier omits it, so the 64 KiB budget still binds any pair that includes a pre-3.3 peer. The Web Bot Auth profile already fetches no capabilities.
