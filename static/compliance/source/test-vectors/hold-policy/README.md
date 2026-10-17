# Hold policy vectors

Reference verdicts for the experimental `hold_policy` object
([refine_proposals](/docs/media-buy/task-reference/refine_proposals#hold-policy-experimental),
feature id `media_buy.hold_policy`). Like the feature, these vectors are
experimental and change with it.

There is no storyboard for `hold_policy` yet. These vectors let buyer SDKs,
seller test suites, and graders check the same rules against frozen inputs in
the meantime.

`vectors.json` contains:

- **`conventions`**: duration arithmetic, hold placement and `hold_placed_at`,
  the two bounds, the effective policy for holders without `hold_policy`,
  presence and the below-3.3 omission, draft derivation, duration ordering, and
  version comparison.
- **`violation_codes`**: every rule a vector can break, with its meaning.
- **`finalize_vectors`**: one `refine_proposals` finalize request, the
  seller's records of its `source_drafts`, the grader's `observation` of when
  the request arrived and the response (or `submitted` completion) left, and
  the seller's `response` or task-level `task_error`.
- **`draft_vectors`**: one draft with the canonical products it allocates.
- **`extend_vectors`**: one `refine_proposals` `extend_hold` request
  (experimental, `media_buy.hold_extension`), the seller's records of its
  committed `source_proposals`, and the seller's `response` or task-level
  `task_error`.

The `ranking` case covers `hold_policy.rankable` and the committed proposal's
`hold_rank` (experimental, `media_buy.hold_ranking`,
[Hold ranking](/docs/media-buy/task-reference/refine_proposals#hold-ranking-experimental))
across all three lists.

Each vector has `expected.violations`, which lists every code the input breaks.
An empty list means conformant. Finalize vectors may also list
`expected.indeterminate`: bounds that cannot be settled either way because
`hold_placed_at` is not on the wire (callers below 3.3). These are not
violations.

| Case | What it checks |
|---|---|
| `hold_bounds` | `expires_at` is no earlier than `hold_placed_at` + `min_duration` and no later than `hold_placed_at` + `max_duration`, and `hold_placed_at` lies between request receipt and response (or completion). Includes the 24-hour day across a DST change, synchronous and submitted finalizes, a missing `hold_placed_at`, and window grading for 3.2 callers. The committed proposal carries `hold_policy` forward unchanged, its `terms_digest` recomputes, its terms match the draft, and the seller declares the feature. |
| `hold_unavailable` | A minimum the seller cannot honor gives `hold_unavailable` with `batch_aborted` siblings. Finalize stays all-or-none. |
| `terms_only_resolution` | A draft with `available: false` commits terms only and never returns `hold_unavailable`. A terms-only entry beside a holdable sibling that returns `hold_unavailable` returns `batch_aborted`. |
| `agent_default` | A draft without `hold_policy` takes the seller's `hold_semantics` when the seller does not list `media_buy.hold_policy`. A seller that lists it states the policy on every 3.3 draft and committed proposal. A `terms_only` agent can hold a product that declares `available: true`. |
| `version_gate` | A no-hold committed proposal is never returned to a caller below 3.3. `UNSUPPORTED_FEATURE` is the refusal, and only when the gate applies. A holdable finalize for a caller below 3.3 omits `hold_policy` and `hold_placed_at`. |
| `draft_consistency` | A feature-listing seller's draft includes `hold_policy`, declares `available: false` when any allocated product's effective policy is non-holdable, and otherwise promises no more than its products (durations and `extendable`). Durations are ordered after normalizing, and `max_total_duration` needs `extendable: true`. |
| `ranking` | A rankable policy finalizes into a hold that reports `hold_rank`, which the schema requires there and forbids under an exclusive policy. A seller emitting `rankable` or `hold_rank` lists `media_buy.hold_ranking`. A draft allocating a rankable product declares `rankable: true`. An `extend_hold` successor never reports a worse position than its source. |
| `extension` | An `extend_hold` successor carries `commercial_terms`, `terms_digest`, `hold_policy`, and `hold_placed_at` forward unchanged, has a later `expires_at`, and stays within the original `hold_placed_at` + `max_total_duration` across the chain. `extendable` absent means false. A source that holds no inventory fails with `INVALID_STATE`, never `hold_unavailable`. |

## Grading

1. Validate the request, drafts, products, and response (or task error)
   against their schemas. If any fails, report only `schema_invalid`.
2. Resolve each draft's effective policy: its `hold_policy`, or
   `{ "available": false }` under `hold_semantics: "terms_only"`, or
   `{ "available": true }` otherwise.
3. Check presence. For a caller below 3.3, no product or proposal in the
   response carries `hold_policy` or `hold_placed_at`. Otherwise, a seller that
   lists `media_buy.hold_policy` puts `hold_policy` on every draft and committed
   proposal. Check duration ordering in every policy.
4. For each finalized entry, recompute `terms_digest` and compare the committed
   `commercial_terms` (and, at 3.3 or later, `hold_policy`) with the draft. If
   the effective policy is non-holdable, check the version gate. If it is
   holdable and the draft declares durations, check both bounds from
   `hold_placed_at`, and check that `hold_placed_at` lies in the observed
   window.
5. For each unable entry, reject `hold_unavailable` on a non-holdable entry and
   `batch_aborted` with no failing sibling.
6. For a draft vector, also check that a holdable draft promises no more than
   any allocated product's effective policy, including an exclusive hold
   (`rankable` absent) over a rankable product.
7. For an extend vector, check each successor against its source: unchanged
   terms, `hold_policy`, and `hold_placed_at`; a later `expires_at`; a source
   whose `extendable` is `true`; and `expires_at` no later than the source's
   `hold_placed_at` + `max_total_duration`. Reject `hold_unavailable` for a
   source that holds no inventory. Under a rankable policy, reject a successor
   whose `hold_rank` is worse than the source's.

Durations use days, hours, minutes, and seconds only. A day is exactly 86400
seconds added to the UTC instant, so `P1D` equals `PT24H` and ignores local
offsets, as the schema and the spec state.

The hold is placed when the seller creates the committed proposal, and a
committed proposal that holds inventory records that instant in
`hold_placed_at`. Callers below 3.3 do not receive it. For them, placement
could be any time between `request_received_at` and `response_at`, and a bound
is a violation only when it fails for every placement in that window.

These vectors do not cover exact-retry replay (the original `hold_placed_at`
and `expires_at` are returned), installment booking deadlines, or
`extend_hold` batches with more than one entry.

`tests/hold-policy-vectors.test.cjs` contains the reference grader and replays
every vector.
