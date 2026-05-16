---
---

Add optional `health_check_url` to agent registration as a fallback liveness signal. When the dashboard probe's MCP handshake fails, the probe now GETs `health_check_url` (if set) and treats any 2xx as "online" — liveness only, no synthetic capabilities. Also classifies common probe failures (auth required, no MCP endpoint at URL, unreachable host) so registrants notice when the registered `agent_uri` is wrong. Closes adcontextprotocol/adcp#3066.
