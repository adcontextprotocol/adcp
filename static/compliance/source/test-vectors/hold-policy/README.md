# Hold policy vectors

Reference verdicts for the experimental `hold_policy` object
([refine_proposals](/docs/media-buy/task-reference/refine_proposals#hold-policy-experimental),
feature id `media_buy.hold_policy`). Like the feature, these vectors are
experimental and change with it.

There is no storyboard for `hold_policy` yet. These vectors let buyer SDKs,
seller test suites, and graders check the same rules against frozen inputs in
the meantime.

`vectors.json` contains:

- **`conventions`**: duration arithmetic, how the hold placement time is found,
  the two bounds, the effective policy for holders without `hold_policy`, and
  version comparison.
- **`violation_codes`**: every rule a vector can break, with its meaning.
- **`finalize_vectors`**: one `refine_proposals` finalize request, its
  `source_drafts`, the grader's `observation` timing, and the seller's
  `response` or task-level `task_error`.
- **`draft_vectors`**: one draft with the canonical products it allocates.

Each vector has `expected.violations`, which lists every code the input breaks.
An empty list means conformant. Finalize vectors may also list
`expected.indeterminate`: bounds that the observation cannot settle either way,
which are not violations.

| Case | What it checks |
|---|---|
| `hold_bounds` | `expires_at` is no earlier than placement + `min_duration` and no later than placement + `max_duration`. Includes the 24-hour day across a DST change, synchronous and submitted finalizes, and grading without a placement time. The committed proposal carries `hold_policy` forward unchanged, its `terms_digest` recomputes, its terms match the draft, and the seller declares the feature. |
| `hold_unavailable` | A minimum the seller cannot honor gives `hold_unavailable` with `batch_aborted` siblings. Finalize stays all-or-none. |
| `terms_only_resolution` | A draft with `available: false` commits terms only and never returns `hold_unavailable`. A non-holdable entry beside a holdable sibling that returns `hold_unavailable` returns `batch_aborted`. |
| `agent_default` | A draft without `hold_policy` takes the seller's `hold_semantics`. A `terms_only` agent can hold a product that declares `available: true`. |
| `version_gate` | A no-hold committed proposal is never returned to a caller below 3.3. `UNSUPPORTED_FEATURE` is the refusal, and only when the gate applies. |
| `draft_consistency` | A draft includes `hold_policy` when an allocated product declares it, and declares `available: false` when any allocated product's effective policy is non-holdable. |

## Grading

1. Validate the request, drafts, products, and response (or task error)
   against their schemas. If any fails, report only `schema_invalid`.
2. Resolve each draft's effective policy: its `hold_policy`, or
   `{ "available": false }` under `hold_semantics: "terms_only"`, or
   `{ "available": true }` otherwise.
3. For each finalized entry, recompute `terms_digest` and compare the committed
   `commercial_terms` and `hold_policy` with the draft. If the effective policy
   is non-holdable, check the version gate. If it is holdable and the draft
   declares durations, check both bounds.
4. For each unable entry, reject `hold_unavailable` on a non-holdable entry and
   `batch_aborted` with no failing sibling.

Durations use days, hours, minutes, and seconds only. A day is exactly 86400
seconds added to the UTC instant, so `P1D` equals `PT24H` and ignores local
offsets. The schema does not say this yet; these vectors assume it.

The hold is placed when the seller creates the committed proposal. That time is
not on the wire yet, so `observation.hold_placed_at` is the grader's own record
and is used only when present. Without it, placement could be any time between
`request_received_at` and `response_at`. A bound is a violation only when it
fails for every placement in that window.

These vectors check product and draft consistency only for presence and the
`available: false` rule. They do not compare draft durations with product
durations.

`tests/hold-policy-vectors.test.cjs` contains the reference grader and replays
every vector.
