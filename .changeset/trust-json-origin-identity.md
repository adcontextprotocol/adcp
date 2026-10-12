---
"adcontextprotocol": minor
---

trust.json v1 (experimental): an agent is identified by the canonical origin of its `url`, one agent per origin, and every agent URL in the record (agents, grant narrowing, acknowledgements) matches by origin. The record carries no keys. Remove `agents[].jwks_uri` and its `/.well-known/jwks.json` default (keys come from the Web Bot Auth key directory at the agent's origin), and drop the planned `identity.trust_url` back-pointer. Add an optional `agents[].key_thumbprints` pin that only narrows keys, checked at binding and grant evaluation. Define "canonical origin" once in `url-canonicalization.mdx`, with a Form column in its "Where it applies" table. Examples move to one origin per agent, and a validator for the one-agent-per-origin and acknowledgement rules, using the SDK's canonicalization, runs in `npm run test:schemas`. Nothing consumes trust.json yet. See `specs/agent-identity-3-3.md` and #8118.
