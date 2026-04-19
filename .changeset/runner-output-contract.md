---
---

spec(compliance): define runner output contract for actionable failure detail (#2352)

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
- Adds a `skip_result` block that requires runners to distinguish
  `not_applicable` (agent did not claim the protocol) from `no_phases`
  (storyboard is a placeholder), `prerequisite_failed`, `missing_tool`,
  `missing_test_controller`, and `unsatisfied_contract` so an agent that
  declares `supported_protocols: ["signals"]` but sees "Signals track — SKIP"
  gets a reason that tells them which of those six cases applies.
- Adds an `extraction` block requiring runners to record which MCP response
  path (`structured_content` vs `text_fallback`) produced the parsed AdCP
  response, so runner extraction bugs are separable from agent bugs.
- Cross-referenced from `storyboard-schema.yaml` — storyboard authors assume
  failures will be rendered with this detail and write descriptions accordingly.

Non-goals: output formatting, scoring thresholds, UI rendering. The contract
specifies minimum actionability; runners remain free to add fields and render
them however the surface requires.
