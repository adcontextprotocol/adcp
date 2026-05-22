---
---

Add distributed brand.json compliance storyboards for 3.1 (issue #4932).

Two new scenario files and a runner contract covering the mutual-assertion trust model
(brand_refs[] + Brand Canonical Document) and typed trademark schema validation:

- `protocols/brand/scenarios/distributed_brand_mutual_assertion.yaml` — consumer-under-test
  happy path (mutual assertion) and leaf-only negative branch.
- `protocols/brand/scenarios/distributed_brand_trademark_validation.yaml` — schema-conformance
  validation for typed trademark status/countries/nice_classes fields.
- `test-kits/distributed-brand-runner.yaml` — runner contract defining fixture house portfolio
  and leaf canonical document for consumer-under-test dispatch.

Consumer-under-test steps gate via `requires_contract: distributed_brand_runner` (matching the
`single_side_trust_extension` precedent) and grade `not_applicable` until adcp-client ships
the consumer dispatch primitive. Non-protocol compliance infrastructure; no bump.
