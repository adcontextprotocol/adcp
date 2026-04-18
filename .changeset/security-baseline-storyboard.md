---
"adcontextprotocol": minor
---

Add `universal/security.yaml` — a conformance storyboard that every AdCP agent
must pass regardless of specialism. Authentication is required for compliance
from the moment this storyboard ships; there is no soft-fail window. Agents
that cannot pass were always non-conformant — the test just makes it visible.

The storyboard verifies:

1. **Unauth rejection on protected operations.** Calling a test-kit-declared
   protected task (`auth.probe_task`, default `list_creatives`) without
   credentials MUST return 401 (preferred) or 403, and on 401 MUST include a
   `WWW-Authenticate` header per RFC 6750 §3. Public discovery tasks
   (`get_adcp_capabilities`, `list_creative_formats`) are out of scope — they
   are unauthenticated by design.

2. **API key enforcement** (when a test-kit key is provided). A valid key
   returns 200; a deliberately invalid key MUST return 401/403. The pair
   catches agents that "pass" with a valid key but actually ignore credentials.

3. **OAuth discovery and audience binding.** When served, the
   `/.well-known/oauth-protected-resource/<path>` document (RFC 9728) MUST
   declare `resource` equal to the full agent URL. Catches the real-world
   audience-mismatch bug seen on a live agent (see adcp-client#563) where
   `resource` pointed at the auth server's origin and every issued token
   had the wrong audience.

4. **Authorization server metadata resolves.** The first
   `authorization_servers[]` entry MUST expose
   `/.well-known/oauth-authorization-server` per RFC 8414 (not OIDC Discovery)
   with `issuer` and `token_endpoint`.

5. **At least one mechanism verified.** API key OR OAuth discovery must
   contribute `auth_mechanism_verified` — rejecting unauth but advertising
   no working auth is not compliant.

Also introduces additive storyboard runner directives documented in
`storyboard-schema.yaml`:

- `auth: none` on a step — force the runner to strip transport credentials.
- `auth: { type: api_key, value: "..." }` — literal Bearer value for
  invalid-key probes.
- `task: "$test_kit.auth.probe_task"` with `task_default` — test-kit-driven
  task selection so the probe works across agent specialisms.
- `contributes_to: <flag>` + `contributes_if: <expression>` + `check: any_of`
  — accumulator so downstream phases can require at least one of several
  optional phases succeeded.
- Validation checks: `http_status`, `http_status_in`, `on_401_require_header`,
  `resource_equals_agent_url`, `any_of`.

SDK-side runner, middleware helpers, test-kit schema additions, HTTPS
enforcement, SSRF guardrails, and cert/docs updates ship in `@adcp/client`
and are tracked in adcp-client#565.
