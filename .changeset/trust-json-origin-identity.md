---
"adcontextprotocol": minor
---

trust.json v1 (experimental): an agent's identity is the canonical origin of its `url`, one agent per origin, and the record carries no keys. Remove `agents[].jwks_uri` and its `/.well-known/jwks.json` default (keys come from the Web Bot Auth key directory at the agent's origin), and drop the planned `identity.trust_url` back-pointer from the `url` description. Add an optional `agents[].key_thumbprints` pin that only narrows keys, and `profiles.adcp.signing_profiles` (`wba`, `adcp-rfc9421`) so an operator can refuse 3.2-profile signatures for an agent. Grant `agents[].url` matches by canonical origin. Examples move to one origin per agent, and a validator for the one-agent-per-origin rule runs in `npm run test:schemas`. Nothing consumes trust.json yet. See `specs/agent-identity-3-3.md` and #8118.
