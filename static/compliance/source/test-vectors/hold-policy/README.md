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
  presence and the below-3.3 omission, draft derivation, duration ordering,
  installment deadlines, exact-retry replay, and version comparison.
- **`violation_codes`**: every rule a vector can break, with its meaning.
- **`finalize_vectors`**: one `refine_proposals` finalize request, the
  seller's records of its `source_drafts`, the grader's `observation` of when
  the request arrived and the response (or `submitted` completion) left, and
  the seller's `response` or task-level `task_error`. A vector may also carry
  `installments`: the seller's records of the `booking_deadline` and
  `change_cutoff` (`core/installment-deadlines.json`)
  of the installments of each product its drafts allocate.
- **`replay_vectors`**: an exact retry of one finalize. It carries the same
  `request` and `source_drafts`, the `original` `observation` and `response`,
  and the `replay` `response` the seller returned to the retry.
- **`draft_vectors`**: one draft with the canonical products it allocates.
- **`extend_vectors`**: one `refine_proposals` `extend_hold` request
  (experimental, `media_buy.hold_extension`), the seller's records of its
  committed `source_proposals`, and the seller's `response` or task-level
  `task_error`. A request may name several sources: the batch is all-or-none.

Each vector has `expected.violations`, which lists every code the input breaks.
An empty list means conformant. Finalize vectors may also list
`expected.indeterminate`: bounds that cannot be settled either way because
`hold_placed_at` is not on the wire (callers below 3.3). These are not
violations.

| Case | What it checks |
|---|---|
| `hold_bounds` | `expires_at` is no earlier than `hold_placed_at` + `min_duration` and no later than `hold_placed_at` + `max_duration`, and `hold_placed_at` lies between request receipt and response (or completion). Includes the 24-hour day across a DST change, synchronous and submitted finalizes, a missing `hold_placed_at`, and window grading for 3.2 callers. The committed proposal carries `hold_policy` forward unchanged, its `terms_digest` recomputes, its terms match the draft, and the seller declares the feature. |
| `hold_unavailable` | A minimum the seller cannot honor gives `hold_unavailable` with `batch_aborted` siblings. Finalize stays all-or-none. |
| `installment_deadline` | A hold never outlives the earliest `booking_deadline` or `change_cutoff` of the installments of the products its draft allocates, even when the draft's `max_duration` would allow it. When `hold_placed_at` + `min_duration` falls after that instant, the entry returns `hold_unavailable` and its siblings `batch_aborted` (the grader does not judge whether a `hold_unavailable` was warranted); committing anyway breaks either `min_duration` or the deadline cap. A deadline on a product the draft does not allocate is ignored. |
| `replay` | An exact retry under the same idempotency key replays the original response: the same committed proposal with its original `hold_placed_at` and `expires_at` (a retry never restarts the clock), and the same `unable` results for a failed finalize. The retry response is flagged `replayed: true`, and `results` (in order) and `products` are compared. A completed result, including an all-`unable` one, is replayed as cached under the [idempotency rules](/docs/building/by-layer/L1/security). |
| `terms_only_resolution` | A draft with `available: false` commits terms only and never returns `hold_unavailable`. A terms-only entry beside a holdable sibling that returns `hold_unavailable` returns `batch_aborted`. |
| `agent_default` | A draft without `hold_policy` takes the seller's `hold_semantics` when the seller does not list `media_buy.hold_policy`. A seller that lists it states the policy on every 3.3 draft and committed proposal. A `terms_only` agent can hold a product that declares `available: true`. |
| `version_gate` | A no-hold committed proposal is never returned to a caller below 3.3. `UNSUPPORTED_FEATURE` is the refusal, and only when the gate applies. A holdable finalize for a caller below 3.3 omits `hold_policy` and `hold_placed_at`. |
| `draft_consistency` | A feature-listing seller's draft includes `hold_policy`, declares `available: false` when any allocated product's effective policy is non-holdable, and otherwise promises no more than its products (durations and `extendable`). Durations are ordered after normalizing, and `max_total_duration` needs `extendable: true`. |
| `extension` | An `extend_hold` successor carries `commercial_terms`, `terms_digest`, `hold_policy`, and `hold_placed_at` forward unchanged, has a later `expires_at`, and stays within the original `hold_placed_at` + `max_total_duration` across the chain. `extendable` absent means false. A source that holds no inventory fails with `INVALID_STATE`, never `hold_unavailable`. A batch of several sources is graded entry by entry against each entry's own source, and stays all-or-none: a declined entry returns `hold_unavailable`, its siblings `batch_aborted`, and a terms-only source fails the whole request with `INVALID_STATE`. |

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
   window. If it is holdable, check that `expires_at` is no later than the
   earliest `booking_deadline` or `change_cutoff` in `installments` for the
   products the draft allocates.
5. For each unable entry, reject `hold_unavailable` on a non-holdable entry and
   `batch_aborted` with no failing sibling.
6. For a draft vector, also check that a holdable draft promises no more than
   any allocated product's effective policy.
7. For a replay vector, grade `original` as a finalize vector. Then require
   the `replay` response to repeat each result: a finalized entry keeps its
   original `hold_placed_at` and `expires_at`, and any other difference is a
   changed response. The retry is not checked against a new observation window.
8. For an extend vector, check each successor against its source: unchanged
   terms, `hold_policy`, and `hold_placed_at`; a later `expires_at`; a source
   whose `extendable` is `true`; and `expires_at` no later than the source's
   `hold_placed_at` + `max_total_duration`. Reject `hold_unavailable` for a
   source that holds no inventory.

Durations use days, hours, minutes, and seconds only. A day is exactly 86400
seconds added to the UTC instant, so `P1D` equals `PT24H` and ignores local
offsets, as the schema and the spec state.

The hold is placed when the seller creates the committed proposal, and a
committed proposal that holds inventory records that instant in
`hold_placed_at`. Callers below 3.3 do not receive it. For them, placement
could be any time between `request_received_at` and `response_at`, and a bound
is a violation only when it fails for every placement in that window.

`tests/hold-policy-vectors.test.cjs` contains the reference grader and replays
every vector.
