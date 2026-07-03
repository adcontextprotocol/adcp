---
id: DR-0001
title: Graded conformance assertions require a normative basis
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-06
decided_by: maintainer practice
refs: ["PR #5719", "#5716"]
dissent: none
---

## Decision

A graded storyboard `validations[]` check may only assert behavior the spec
mandates — a spec MUST or a schema `required[]` field. Scenario `expected:`
prose and specialism narrative are not normative sources and must not be turned
into graded assertions.

## Rationale

PR #5719 added a `governance_context` echo assertion derived from scenario
prose; the spec mandates buyer→seller→governance forwarding, not a
seller→buyer echo. Grading non-normative prose punishes conformant
implementations for behavior the spec never required.

## Implications

- Happy-path steps often have no gradeable invariant — the verifiable signal is
  usually on the error path or out-of-band. That is acceptable; do not invent
  assertions to fill the gap.
- Conversely, `expected:` prose that *should* be binding is a spec gap: promote
  it to normative language first, then grade it.
