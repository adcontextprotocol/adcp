# Reporting subscription coverage vectors

Canonical coverage vectors for experimental principal-level reporting
subscriptions (`media_buy.reporting_subscriptions`,
[get_reporting_status](/docs/media-buy/task-reference/get_reporting_status#subscription-coverage),
[sync_principal](/docs/protocol/sync_principal#reporting-subscriptions)). Like
the feature, these vectors are experimental and change with it.

A buyer computes which periods a subscription owes without asking the seller.
These vectors give the input a buyer holds and the exact owed periods, so SDKs
and seller test suites can check the same rule against frozen inputs, and
against something neither of them wrote.

- `vectors.json` holds the cases, the pinned tzdata release, the conventions,
  and the error codes.
- `case.schema.json` describes one case and every input field.

## How the expected rows were derived

Each expected row is derived from the normative text named in the case's
`spec_refs`:

- `core/reporting-subscription.json` `x-adcp-validation`: coverage, cutover,
  selection, and precedence.
- `core/reporting-schedule.json` `period_generation`.
- `core/reporting-subscription-coverage.json`,
  `core/reporting-subscription-state.json`, and
  `core/account-authorization.json`.

`rule` explains each derivation.

Cases with `origin: "adcp-client#3505"` were ported from the TypeScript SDK's
parity table and re-derived independently. Cases with `origin: "adcp"` were
added here. A case whose input differs from its origin says how in
`changed_from_origin`.

`scripts/reference/reporting-coverage/` is a brute-force reference model,
written from the same text. It enumerates every period of every schedule in
play and keeps a period only when each clause admits it.
`tests/reporting-subscription-coverage-vectors.test.cjs` runs it over every
case. `tests/reporting-subscription-coverage-properties.test.cjs` checks
properties of the rule over seeded random inputs:

- Exceptions only remove periods.
- Nothing is owed twice.
- The cutover stretch is shorter than one incoming period.
- The owed set is prefix-stable as `now` advances.
- An extension never adds an elapsed period.
- Calendar invariants hold.

## Time zones

Expected rows use the IANA tzdata release named in `tzdata`. Each case lists in
`timezones` the zones its rows depend on. Dates were chosen where tzdata
releases 2026b through the pinned release agree, so an implementation on any
of them should reproduce every case. For example, Cuba's fall-back is tested
on 2025-11-02 because 2026f removed the 2026-11-01 one. If your time zone
database is a different release and a case disagrees, compare it against the
pinned release first.

The reference model does not use ICU, `Intl`, Temporal, TZif files, or the
host's zoneinfo. It evaluates the zic source lines of the pinned release
itself, from `scripts/reference/reporting-coverage/tzdata.json`. The test
checks that evaluation against zic(8) output for the same release.

## Wiring a vector into an SDK test

For each case:

1. Build your SDK's coverage input from `input`. `case.schema.json` says where
   each field comes from on the wire. Fields listed in `non_wire_inputs` are
   ones a buyer must retain itself.
2. When the case has `expected_error`, assert your SDK refuses the input. Map
   your error to the `code` it corresponds to.
3. Otherwise compare your rows with `expected`, and your grouped obligations
   with `expected_obligations`, as instants rather than strings, in the order
   `conventions.rows` gives.

## Case groups

| Group | What the cases check |
|---|---|
| Start bound and flights | The later of `accepted_at` and `authorized_at`, the confirmation period owed in full, the stop-time period owed in full, cancellation, completion, empty flights, late confirmation, and flight values as of each period end (extension and reinstatement never add an elapsed period). |
| Cutovers | New versions on aligned and misaligned schedules, a version change on a boundary, two cutovers inside one period, deactivation, reactivation, and resolution changes. Compound changes at one instant: a version change with a timezone change, a reactivation, a deactivation, or a revocation. |
| Authority | Revocation, re-grant with and without `backfill_on_regrant`, expired `accounts_unauthorized` entries, a re-grant exactly at the retention limit, and chains of three and four grants. |
| Exceptions | `excluded[]` and `gaps[]` remove periods by start, offering-scoped entries (including `max_accounts` capacity on offerings with different boundaries), `package_ids` entries, precedence. |
| Selection | `exact`, `finest`, and `all`, byte-order ties, unmapped and unknown dimensions, finality, purpose, duration, destination, product eligibility, per-product resolution, and `period_timezone` matching. |
| Period generation | DST gaps and folds at midnight (America/Santiago, America/Havana, Africa/Cairo), Australia/Lord_Howe's 30-minute DST, sub-daily local periods in Asia/Singapore and Asia/Kathmandu, a skipped civil date (Pacific/Apia), PT24H against P1D, utc sub-daily periods counted from 1970, month-end clamps from 31st and February 29 anchors, P3M, weeks (P7D, starting Thursday from the 1970 origin), and years. |
| Input errors | Numeric offsets, missing zones, a missing `previous_timezone`, missing `standard_dimensions`, a missing retention window, P1W (the duration pattern has no W), and invalid local durations. |
