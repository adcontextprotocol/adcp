# SDK response evidence

This implements the first catalog/error scope of [adcp#7439](https://github.com/adcontextprotocol/adcp/issues/7439). It complements `scripts/audit-sdk-lifecycle-compatibility.cjs` and the training-agent dispatch smoke test. It does not replace their handwritten translation, coverage/targeting, idempotency or continuation checks.

The probe uses real TypeScript, Python and Go SDK server helpers and MCP clients over in-memory transports. No partner endpoint, account, authentication credential or purchase is involved. The two business fixtures are deliberately empty catalogs: this proves envelope behavior, not product eligibility or a completed purchase.

## Run

Use Node 24, Python 3.12 and the Go version in `go/go.mod`. Install repository dependencies with `npm ci`, then install `requirements.txt` into a Python virtual environment. TypeScript uses the exact SDK in the repository lockfile; Python and Go have explicit SDK and MCP pins. Each observation records the installed versions, runtime, and Go module checksum.

```sh
python3 -m pip install -r scripts/sdk-response-conformance/requirements.txt
npm run test:sdk-response-conformance
bash scripts/sdk-response-conformance/run.sh .context/sdk-response-conformance
```

Follow the repository's Docker requirement for local execution. CI installs these runtimes on an ephemeral runner. Each driver must use the protocol artifact embedded by that exact SDK package:

```sh
node scripts/probe-sdk-response-conformance.cjs prepare 3.2.0-rc.3 > .context/plan-typescript.json
node scripts/probe-sdk-response-conformance.cjs prepare 3.2.0-rc.1 > .context/plan-python-go.json
node scripts/sdk-response-conformance/typescript.cjs .context/plan-typescript.json > .context/typescript.json
python3 scripts/sdk-response-conformance/python.py .context/plan-python-go.json > .context/python.json
# Run go run . with the absolute RC.1 plan path from scripts/sdk-response-conformance/go.
node scripts/probe-sdk-response-conformance.cjs report-matrix \
  .context/plan-typescript.json .context/typescript.json \
  .context/plan-python-go.json .context/python.json > .context/report.json
```

The report exits **1 for findings or skipped cases**, **2 for a harness failure**, and 0 only when the covered fixtures pass. Unimplemented manifest tools still appear in the inventory; 0 never means full-protocol conformance. The three-language runner maps driver failures to 2, preserving this distinction.

## What the evidence means

- **Inventory:** exactly the selected immutable release's canonical manifest, joined with each configured server's `tools/list`. Historical copies and MCP projections are not counted as extra tools. Tools without business/state fixtures and failed request generation have explicit reasons.
- **Requests:** deterministic required-property candidates, local `$ref` resolution, recorded union choices and unselected alternatives, bounded recursion, then AJV validation before dispatch. Conditional/pattern constraints that the generator cannot satisfy are reported, not bypassed. Optional request branches remain explicitly untested. The only request override is `get_products.buying_mode = wholesale`; add named fixtures for accounts, authentication, identifiers and continuations as coverage grows.
- **Versions:** the SHA-256 covers the canonical JSON files by sorted relative path and content hash, excluding generated MCP/bundled projections. A release such as `3.2.0-rc.3` uses the published wire selector `3.2-rc.3`. The controlled server fixture selects the immutable artifact; the response or SDK handler context provides the served selector. No request pin is copied into served-version evidence. An absent or unavailable served contract makes validation provisional, not a claim that a legacy peer is invalid merely for omitting version metadata.
- **Responses:** capture the actual MCP result and validate against the served release. Tool errors use the published `core/error.json` and MCP binding; they are never checked as successful task payloads. Published error-code metadata separately checks recovery semantics. Extension-code overrides exercise all three recovery values without asserting that standard classifications may be changed arbitrarily.
- **Transport:** TypeScript uses `createAdcpServer`'s supported low-level `legacy/v5` entry with `mcpToolProfile: all`, so retained and compact discovery are visible. Python uses `create_mcp_server` with typed task exceptions built from the actual `adcp_error` helper. Its public MCP request API captures output before the client's output-schema validator can throw it away; that validator still runs and its errors are retained. Go uses `Register`, `ProductsResponse`, and the `NewError` → `Errorf` path. SDK self-validation is disabled where configurable so an invalid response remains observable; independent release-schema validation is always on.
- **Limits:** no A2A coverage, nonempty catalog translation, live-partner evidence, purchase execution or continuation replay. The generator is a bounded fixture builder, not a general constraint solver. Go's current `Register` does not expose `ListProducts`, and its product/error helpers provide no served-version evidence.

## Initial findings and regression policy

The baseline was first recorded with `@adcp/sdk@14.0.0-rc.35`, `adcp==8.0.0b14`, and Go `adcp/v3@v3.2.1` against RC.1. The current evidence pairs TypeScript `@adcp/sdk@14.0.0-rc.40` with RC.3 while retaining the explicitly pinned Python and Go packages; each baseline entry records its exact protocol artifact and package version. There are two catalog cases, one case for every published error default, and three overrides per language. Go skips native listing. The report records:

- TypeScript: error defaults and overrides agree; `list_products` gains `adcp_version`, which the raw pinned response schema forbids. This is a schema/envelope inconsistency, related to the prior [SDK normalization fix #2594](https://github.com/adcontextprotocol/adcp-client/issues/2594); it is not a claim that the fixed SDK client still rejects the response. The probe deliberately retains the raw artifact result instead of silently stripping fields or patching an immutable schema.
- Python: 84 default recovery classifications differ from the published metadata; native listing gains `status: completed`, rejected both by the raw pinned schema and the MCP client's advertised-output validator.
- Go: [#530](https://github.com/adcontextprotocol/adcp-go/issues/530) reproduces with six invalid recovery values and 110 incorrect classifications. The catalog helper also omits required `status`. All 123 dispatched cases lack served-version evidence, so their selected-artifact checks remain provisional. Missing metadata is an evidence limitation, not automatically a fatal protocol error.

`known-findings.json` is an explicit regression baseline, **not an allowlist that makes the conformance report pass**. The CI job checks that exact SDK pins, artifact digest, coverage counts, findings and skips still match the reviewed evidence. It uploads raw observations and reports and publishes their counts. New defects, resolved defects, changed coverage or SDK/artifact pins require a deliberate baseline update and review. The ordinary report continues to exit 1 while findings remain. Do not weaken schemas or hide failures to make the baseline green.

Negative controls reuse the repository's transport-error vectors and AJV stack. They prove that malformed envelopes, bad recovery enums, wrong enum-valid classifications, artifact drift, missing observations and unavailable served versions cannot pass silently.
