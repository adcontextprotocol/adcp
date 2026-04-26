---
---

docs(compliance): enumerate a2a_submitted_artifact in storyboard-schema check list

Adds `a2a_submitted_artifact` to the canonical `check:` enum comment in
`static/compliance/source/universal/storyboard-schema.yaml` and adds a sibling
documentation section (modelled after the existing `refs_resolve` section) that
describes the A2A wire-shape invariants the check asserts, its `not_applicable`
self-skip on non-A2A transports, and its provenance (adcp-client#899 / #952).

Documentation-only: the runner already supports the check as of adcp-client#952;
no schema, task definition, or wire-format change.
