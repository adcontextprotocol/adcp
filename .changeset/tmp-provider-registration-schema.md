---
"adcontextprotocol": minor
---

feat: add TMP provider registration schema, health endpoint, provider lifecycle, and timeout clarification

Adds `provider-registration.json` schema formalizing provider endpoint, capabilities, countries/uid_types (conditionally required for identity_match), timeout, priority, and lifecycle status (active/inactive/draining). Updates specification.mdx, router-architecture.mdx, and buyer-guide.mdx with health endpoint (GET /health), dual discovery models (static config and dynamic API with SSRF guidance), and clarified per-provider vs overall latency budget semantics.
