---
---

spec(compliance): runner output contract + security hardening for actionable failure detail (#2352)

Storyboard runners (evaluate_agent_quality, `@adcp/client storyboard run`, any
other compliance harness) MUST emit enough detail on validation failures for an
implementor to self-diagnose without guesswork. Today a bare "Check agent
capabilities" failure is indistinguishable from a transport bug, a schema drift
bug, or a genuine agent bug.

- New `static/compliance/source/universal/runner-output-contract.yaml` defining
  the minimum shape of a validation failure result: exact request sent, exact
  response received, RFC 6901 JSON Pointer to the failing field, machine-readable
  expected vs. actual values, and — for `response_schema` checks — the `$id`
  and fetchable URL of the schema that was applied. Implementors can re-validate
  locally against the same artifact the runner used, eliminating the "my local
  AJV run passed" class of dead-end debugging.
- `skip_result` block requires runners to distinguish `not_applicable` (agent
  did not claim the protocol) from `no_phases` (storyboard is a placeholder),
  `prerequisite_failed`, `missing_tool`, `missing_test_controller`, and
  `unsatisfied_contract`. Acknowledges that runners MAY track narrower internal
  reasons and map them onto the canonical six for stable machine-readable output.
- `extraction` block requires runners to record which MCP response path
  (`structured_content` vs `text_fallback`) produced the parsed AdCP response,
  so runner extraction bugs are separable from agent bugs.
- A2A response payload shape is now specified precisely:
  `task.artifacts[0].parts[]` DataPart for final states, `task.status.message.parts[]`
  for interim states, `status.state` alongside payload.

**Security hardening (v1.1.0).** A runner that emits exact request/response
payloads into a shared report could leak credentials or agent-planted
breadcrumbs. Four normative rules close this gap, derived from the conforming
implementation at adcp-client#611:

- **Payload redaction.** Values at keys matching a minimum case-insensitive
  regex (authorization, token, api_key, password, secret, bearer, cookie,
  set-cookie, and variants) are replaced with `"[redacted]"` before emission.
  The pattern is a floor; runners MAY extend but MUST NOT narrow.
- **Response-header allowlist.** Only `content-type`, `content-length`,
  `content-encoding`, `www-authenticate`, `location`, `retry-after`,
  `x-request-id`, `x-correlation-id` pass through. Everything else is dropped
  (not redacted) to avoid publishing the set of header names a hostile agent
  added.
- **Request headers.** Runners SHOULD NOT populate request.headers by default
  — echoing an in-flight `Authorization: Bearer <token>` into a shared report
  is a credential leak. When populated (auth-override probes), keys matching
  the redaction pattern MUST be redacted and all others MUST pass the
  allowlist.
- **LLM fencing.** Agent-controlled `error` / `actual` strings rendered into
  shared surfaces MUST be fenced so a hostile error message cannot inject
  instructions into a downstream summarizer.

Non-goals: output formatting, scoring thresholds, UI rendering. The contract
specifies minimum actionability; runners remain free to add fields and render
them however the surface requires.

Conforming implementation: adcp-client#611.
