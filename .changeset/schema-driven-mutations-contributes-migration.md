---
---

compliance(storyboards): schema-driven mutating tasks + contributes shorthand migration

Closes #2669 and #2662.

**Schema-driven MUTATING_TASKS (#2669).** The contradiction lint's
prior-state discrimination previously read a hardcoded `MUTATING_TASKS`
set in `scripts/lint-storyboard-contradictions.cjs`. The set had drifted
from the spec (`sync_audiences` was missing) and required manual updates
whenever new mutating tasks shipped.

The set is now derived at lint-time by walking `static/schemas/source/`
for every `*-request.json` that lists `idempotency_key` in its top-level
`required` array. Mirrors the existing `loadMutatingSchemaRefs` pattern
in `scripts/build-compliance.cjs`. A `MUTATING_EXCEPTIONS` set retains
one documented carve-out: `comply_test_controller` mutates controller
state but is naturally idempotent (its schema description explicitly
justifies the absence of `idempotency_key`).

Three new drift-guard tests protect the invariant:
- `MUTATING_TASKS === (schema-derived ∪ MUTATING_EXCEPTIONS)`
- no redundancy between `MUTATING_EXCEPTIONS` and the schema-derived set
- anchor-task coverage (`create_media_buy`, `update_media_buy`,
  `sync_creatives`, `sync_audiences`) so a schema rename localizes the
  break.

**contributes shorthand migration (#2662).** `@adcp/client` 5.8.1
accepts `contributes: true` inside a `branch_set:` phase; the runner's
loader resolves it to the enclosing phase's `branch_set.id`. This PR
adopts the shorthand in the two universal branch-set storyboards:
`schema-validation.yaml` (past_start_handled) and `security.yaml`
(auth_mechanism_verified). Four call sites migrated.

Dogfoods the spec + client + lint stack end-to-end. Verified locally:
storyboards pass 36/56 clean, 295 steps (both above regression floors).
The schema doc's guidance updated to name both forms as semantically
equivalent, with the shorthand preferred inside branch_set phases.
