---
---

spec(compliance): lint storyboards for idempotency_key on mutating steps (#2372)

`scripts/build-compliance.cjs` now fails the build if any storyboard step
invokes a mutating task without declaring `idempotency_key` in
`sample_request`. A mutating task is any task whose request schema lists
`idempotency_key` in its top-level `required` array — so the lint derives
its task set from the schemas themselves (source of truth) rather than a
hardcoded list. New mutating tasks are covered on arrival; no registry to
forget to update.

Skip rules:
- `expect_error: true` steps (they exercise invalid-request paths,
  including the "missing idempotency_key returns INVALID_REQUEST" test in
  `universal/idempotency.yaml`).
- `test-kits/` fixtures and `storyboard-schema.yaml` (not storyboards).
- Tasks whose request schema does not require `idempotency_key` (discovery,
  read-only, terminate-by-session-id, etc.).

Cleanup included: 101 pre-existing omissions across 38 storyboard files
(media-buy baseline, sales-* specialisms, creative-* specialisms, signals
specialisms, governance, content-standards, collection-lists, etc.) are
fixed in the same commit. Each step gets
`idempotency_key: "$generate:uuid_v4#<storyboard>_<phase>_<step>"` —
unique per step per run, descriptive enough to grep. The
`@adcp/client@5.x` runner (adcp-client#602) forwards storyboard-declared
idempotency_keys through to the wire, so these examples now match what
gets sent.

Error message shape — one line per offending step:

    Storyboard idempotency_key lint: N step(s) invoke a mutating task
    without declaring idempotency_key in sample_request.

      specialisms/X/index.yaml phase=P step=S: task "T" is mutating
      (schema X/Y-request.json requires idempotency_key) but
      sample_request omits it.

    Add `idempotency_key: "$generate:uuid_v4#<alias>"` to each
    sample_request. ...

Closes the loop from adcp-client#611 review: the runner-output contract
helps *diagnose* missing idempotency at runtime; this lint *prevents*
storyboards from shipping without it.
