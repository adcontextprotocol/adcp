---
"adcontextprotocol": minor
---

Add normative `response_schema_validator_semantics` clause to `runner-output-contract.yaml`.

Runners MUST apply the referenced JSON schema with a draft-07 compliant validator that honours the schema's own `additionalProperties` declaration without process-level override. Configuring AJV `removeAdditional: 'all'` or Zod `.strict()` on derived schema objects in a way that contradicts the schema's `additionalProperties: true` declaration is a conformance violation. Addresses issue #4419, where the comply runner produced false-negative verdicts for spec-valid seller responses that included optional or newly-added fields (`authorization`, `sandbox`).
