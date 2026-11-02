# SDK interop: reporting subscriptions and account requests

Cross-SDK tests for experimental AdCP 3.3 principal-level reporting
subscriptions (`media_buy.reporting_subscriptions`) and account requests
(`account.requests`). They run against the published TypeScript SDK
(`@adcp/sdk`) and Python SDK (`adcp`) pre-releases, so they check that the two
SDKs agree on the wire, not only on the shared vectors in
`static/compliance/source/test-vectors/reporting-subscriptions/`.
`.github/workflows/sdk-interop.yml` runs them nightly and on
`workflow_dispatch`.

## Setup

```bash
export ADCP_INTEROP_ENV=/tmp/adcp-interop-env
tests/interop/setup-env.sh                       # @adcp/sdk@beta, adcp>=10.0.0b0
tests/interop/setup-env.sh --ts git:main --py git:some-branch   # git refs
```

The script installs both SDKs into `$ADCP_INTEROP_ENV`, never into the
repository's `node_modules`. It pins time zone data to IANA 2026f, the release
`vectors.json` names. The TypeScript SDK resolves zones through Node's ICU, so
the harness points `ICU_TIMEZONE_FILES_DIR` at ICU's 2026f resources, fetched
from unicode-org/icu-data and checked by SHA-256. Python uses the
`tzdata==2026.6` wheel with an empty `PYTHONTZPATH`. Both CLIs refuse to run on
any other release.

## Differential coverage testing

```bash
node tests/interop/differential/run.cjs --count 2000 [--seed N] [--vectors]
node tests/interop/differential/run.cjs --seeds 25,102     # replay specific seeds
```

- `differential/generate.cjs` generates seeded scenarios in the vector input shape
  (`case.schema.json`). They are weighted toward hard cases:
  - DST changes in Santiago, Havana, Cairo and Lord Howe;
  - month-end billing cycles and sub-daily local periods;
  - version cutovers, including onto billing feeds (stubs);
  - re-grant chains around `status_retention_days`;
  - exceptions, capacity and in-place membership edits;
  - cancellation, `flight_history`, offering availability, timezone cutovers;
  - inputs that must be refused.

  Every scenario is validated against the case schema and the AdCP wire
  schemas first (`differential/validate.cjs`).
- Each scenario runs through three implementations, and their rows,
  obligations and errors (by code and detail) are compared:
  - the reference model in `scripts/reference/reporting-coverage/`;
  - `owedSubscriptionPeriodsV1` (`differential/cli-ts.mjs`);
  - `owed_subscription_periods` (`differential/cli_py.py`).
- When the three disagree, `differential/minimize.cjs` shrinks the scenario while
  the disagreement stays the same. The result is written to
  `out/candidates/candidate-<seed>.json` as a case in the vector shape, with
  each implementation's output, and the run fails. Its expected rows are the
  reference model's and are marked provisional. Derive them from the spec text
  before you promote a candidate into `vectors.json`.

Both CLIs read one input, or a JSON array of inputs, on stdin. With `--lines`
they read one input per line.

## Buyer x seller matrix

```bash
node tests/interop/matrix/run.cjs [--pairs ts:py,py:ts,ts:ts,py:py]
```

The matrix runs {TS buyer, Python buyer} against {TS seller, Python seller}.
Only cross-SDK pairs count as interop. Same-SDK pairs are controls: they show
that a failure comes from an SDK, not from the harness. `matrix/CONTRACT.txt`
defines the process contract. Each SDK side lives in `matrix/ts/` or
`matrix/py/` and imports only its own SDK.

Sellers run on each SDK's managed path, with a virtual clock and a control
route for time, grants and buys. The Python seller stands in until
adcp-client-python ships its own reference seller.

Each pair walks one scripted timeline:

1. subscribe;
2. a version cutover;
3. revoke and re-grant;
4. a cutover back;
5. deactivate and reactivate;
6. a DST change on the local offering.

At each checkpoint the buyer computes owed periods from wire reads alone, with
its own SDK. The harness compares them with the seller's engine and with the
obligations `get_reporting_status` serves, and expects zero discrepancies.

A second script exercises `request_account` / `accounts.ensure` round trips:

- opens that resolve as matched or created, go pending with a buyer action,
  come back ambiguous or rejected, or repeat an open request;
- approval by the seller, then a refresh;
- changes that resolve as updated, as created (a separate account), as in
  review and then updated, or as rejected.

## Self-test

`node --test tests/interop/harness.test.cjs` checks the generator, the
comparison and the minimizer without either SDK.
