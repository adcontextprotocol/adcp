---
---

test(brand-protocol): conformance red test for single-side trust extension on `verify_brand_claim` (#4597).

Adds `protocols/brand/scenarios/single_side_trust_extension.yaml` and the
`test-kits/single-side-trust-runner.yaml` harness contract. Three variants —
subsidiary, property, trademark `licensed_in` — drive a partner under test
through the malicious-house walkthrough from `/brand-protocol/brand-json#agent-augmented-verification`
and assert via `upstream_traffic`:

- `min_count: 1` against the reciprocation endpoint (leaf `brand.json` crawl
  for subsidiary; property real-owner crawl for property; licensor `brand.json`
  crawl for trademark `licensed_in`).
- `min_count: 0` against trust-extension side-effect patterns (member
  auto-provisioning, governance-context creation, billable seat inclusion,
  creative-clearance auto-approval).

No schema or wire-protocol changes; no surface bump. The scenario is a
consumer-under-test conformance test — the storyboard framework currently
grades agents serving tasks, so every graded step declares
`requires_contract: single_side_trust_runner` and grades `not_applicable`
until adcp-client lands the consumer-under-test dispatch and a partner
adopter advertises the `evaluate_verify_brand_claim_trust_extension`
comply_test_controller scenario documented in the runner contract.
