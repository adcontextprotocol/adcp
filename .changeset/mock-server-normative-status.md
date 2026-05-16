---
---

docs(conformance): add mock-server authority and failure triage (#4029)

Adds an explicit normative statement about the mock-server's authority
in the AdCP conformance hierarchy. The SDK stack page already called the
mock-server the "spec-compliance oracle" but provided no upstream anchor
for the triage order SDK authors and implementers need when a storyboard
failure surfaces a disagreement between the spec, the mock, and an SDK.

**Changes:**

- `docs/building/verification/conformance.mdx` — Expands the "When a
  storyboard fails" section with a new "Mock-server authority and failure
  triage" subsection:
  - States the authority chain explicitly: **spec → mock → SDK**
  - Decision table covering the four conditions (SDK≠mock, SDK=mock but
    wrong, storyboard conflict, spec-vs-mock contradiction) with verdict
    and next-step routing
  - Scopes the chain to stable surfaces only (experimental surfaces
    marked `x-status: experimental` are explicitly out of scope)
  - Distinguishes spec ambiguity (mock interpretation is authoritative)
    from spec silence (chain breaks; file a known-ambiguities issue)

- `docs/building/cross-cutting/sdk-stack.mdx` — Adds a forward-reference
  from the existing "spec-compliance oracle" paragraph to the new
  conformance anchor.

**Non-breaking:** docs-only addition. No schema, storyboard, or server
code changes. No existing conformance rule is modified; the triage
decision tree formalizes what the storyboard-as-spec design already
implies.

Closes #4029.
