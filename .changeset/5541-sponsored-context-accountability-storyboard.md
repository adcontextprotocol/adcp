---
"adcontextprotocol": minor
---

Add brand-side sponsored_context_accountability storyboard under `compliance/source/protocols/sponsored-intelligence/sponsored-context-accountability.yaml`.

Refs #5541 (bragent conformance testbed offer) and #5486 (RFC: sponsored context influence modes and disclosure obligations for SI). Exercises the PR #5501 surfaces against a brand-side SI agent in four phases inside a single yaml so the review surface stays small and the contract is visible together:

- `presentation_only_happy_path` — agent emits a `sponsored_context` envelope with `paying_principal.brand.domain`, `context_use=presentation_only`, `disclosure_obligation`, and `declared_by.role=brand_agent`; host returns an accepted receipt with matching `accepted_context_use`; second brand turn lands cleanly.
- `required_disclosure_commitment` — literal `sponsored_context` carries `disclosure_obligation.required=true`; host's receipt carries `disclosure_commitment.status=accepted`; agent accepts the well-formed receipt without error.
- `rejected_receipt` — host returns `host_receipt.status=rejected` with a `rejection_reason`; agent accepts the rejection as a valid wire response (the audit trail records the decline).
- `silent_downgrade_rejected` — host returns an accepted receipt whose `accepted_context_use` does not match the declared `context_use`; the agent MUST reject. Regression anchor is `error_code ∈ {VALIDATION_ERROR, INVALID_REQUEST}` (the canonical AdCP enum); the recommended "silent downgrade forbidden" message wording stays in the step's `expected:` text as a manual-review pointer, not a hard check (promoting it would require a new `error_message_contains` matcher in the runner).

Uses only the existing storyboard matchers (`response_schema`, `field_present`, `field_value`, `error_code`). LLM-generated `response.message` is asserted as present/non-empty only, so language and provider are implementation choices.

bragent (kapoost/bragent, v0.2.0+) serves as the empirical reference surface from which the assertions were derived; the storyboard itself is decoupled from any live service.
