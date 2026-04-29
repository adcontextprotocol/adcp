# AdCP RFC: Release-precision protocol version negotiation

## Summary

Add `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level envelope field on every request and response. Clients send the release they're pinned to; servers echo the release they actually served. Augments the existing `adcp_major_version` (integer per-request) with finer precision and adds **response-side echo**, which the spec lacks today. Transport-uniform across MCP (streamable-HTTP and stdio) and A2A. Composed via `allOf $ref` to a single shared schema (`core/version-envelope.json`) so the field's definition lives in one place across all 127 task schemas.

## Motivation

The spec already has wire-level version negotiation at **major** precision: `adcp_major_version: integer` per-request, `adcp.major_versions: integer[]` on capabilities, `VERSION_UNSUPPORTED` error code, and a documented "any 3.x buyer works against any 3.x server" forward-compat promise within a major.

In practice, that promise doesn't hold cleanly. Clients and servers are now matched at release boundaries:

- **Per-instance release pinning in client SDKs** (Stripe model). Buyers want to say "this client speaks 3.0, not 3.1, and validates accordingly" — not just "I'm major 3."
- **Multi-tenant deployments** where one seller's clients are on 3.0 and another's are on 3.1.
- **Compliance harnesses** that exercise cross-release interop in one process.
- **Controlled rollout** of releases that introduce field-shape changes — including the rare cases where a release ships a breaking fix that the strict additive-only rule didn't catch.

Major-precision is no longer the actual interop boundary; release is. The wire needs to carry it.

The signal must be:

- **Transport-uniform.** HTTP headers (Stripe's choice) don't exist on stdio-MCP. Excluded.
- **Not in `extensions.*`.** Version is meta-protocol, not a feature. A versioned extension surface can't carry the signal that selects its own version.
- **Top-level on the AdCP payload.** First-class field on every request and response schema.

### Relationship to MCP `protocolVersion` (initialize handshake)

MCP carries its own `protocolVersion` field on the `initialize` request/response (e.g. `"2024-11-05"`, `"2025-06-18"`). That handshake versions the **MCP wire** — JSON-RPC framing, capability negotiation, transport semantics. `adcp_version` versions the **AdCP payload** — the schema of `params` and `result` content.

The two are independent and both required:

- An MCP-2025-06-18 server can speak AdCP 3.0 *or* AdCP 3.1.
- An MCP-2025-06-18 client pinning AdCP `"3.1"` will fail (with `VERSION_UNSUPPORTED`) against a server that only speaks AdCP 3.0, even though the MCP handshake succeeded.

A2A has no equivalent to MCP's `initialize`, which is the reason `adcp_version` rides on the payload (where both transports can carry it) rather than replacing MCP's mechanism.

## Spec changes

### 1. Shared envelope schema

Define `core/version-envelope.json`:

```json
{
  "$id": "/schemas/core/version-envelope.json",
  "type": "object",
  "properties": {
    "adcp_version": {
      "type": "string",
      "description": "Release-precision AdCP version (VERSION.RELEASE, e.g. \"3.0\", \"3.1\", \"3.1-beta\"). On a request: the buyer's release pin. On a response: the release the seller actually served.",
      "pattern": "^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$",
      "examples": ["3.0", "3.1", "3.1-beta", "3.1-rc.1"]
    },
    "adcp_major_version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 99,
      "description": "DEPRECATED — see migration table. Removed in 4.0."
    }
  }
}
```

Every AdCP request and response schema composes this via `allOf`:

```json
{
  "$id": "/schemas/<task>-request.json",
  "type": "object",
  "allOf": [{ "$ref": "/schemas/core/version-envelope.json" }],
  "properties": { /* task-specific */ },
  "additionalProperties": true
}
```

The single source of truth for both fields lives in `core/version-envelope.json`. Bundled schema output (used by code generators that don't follow `$ref`) inlines the envelope at build time.

> **Note:** distinct from the existing `core/protocol-envelope.json`, which describes the protocol-layer wrapper (`context_id`, `task_id`, `status`, `payload`) added by MCP/A2A/REST. `version-envelope.json` is part of the payload itself.

**Composition invariant.** Schemas that compose the envelope via `allOf $ref` MUST have `additionalProperties: true` (or absent — defaults to true) at their outer root. JSON Schema draft-07 `allOf` does not bypass the parent's `additionalProperties` — a strict parent rejects the envelope's fields outright. The strict-additional-properties variant returns at draft 2019-09 via `unevaluatedProperties: false` (tracked separately). The build pipeline carries a CI lint (`tests/lint-version-envelope.test.cjs`) that fails any schema violating the invariant.

The field has the same name on both sides of the wire — semantics fall out of context (request body vs response body), matching the Stripe-Version model.

Placement per transport:

- **MCP / JSON-RPC:** `adcp_version` at the top of `params` (request), `result` (response), `error.data` (error).
- **A2A:** `adcp_version` at the top of the AdCP message body.

### 2. Granularity: release, not patch

The negotiation field uses **release precision** (`"3.0"`, `"3.1"`), not patch (`"3.1.2"`):

- Per the spec's own three-tier model, **patch** = bug fixes, always safe to upgrade, no contract change. Negotiation is about contract compatibility — patches don't qualify.
- Patch precision on the wire would force every server to declare its build patch; every client's `supported_versions` list would churn on releases that don't affect interop.

For operational visibility — "which build patch is this server on" — servers MAY emit `build_version` in the capabilities response as advisory metadata.

#### `adcp_version` canonical wire shape

`adcp_version` MUST match `^\d+\.\d+(-[a-zA-Z0-9.-]+)?$` — `MAJOR.MINOR` optionally followed by a pre-release tag. **No patch component is ever valid on the wire**, even alongside a pre-release.

| Wire value | Status |
|---|---|
| `"3.1"` | Valid (release). |
| `"3.1-beta"` | Valid (release with pre-release tag). |
| `"3.1-beta.1"` | Valid (release with dot-extended pre-release tag). |
| `"3.1-rc.1"` | Valid. |
| `"3.1.2"` | **Invalid** — patch on the wire. Use release `"3.1"` and surface the patch as `build_version`. |
| `"3.1.0-beta.1"` | **Invalid** — patch component present. Normalize to `"3.1-beta.1"` before emitting. |
| `"v3.1"` | **Invalid** — no `v` prefix. |
| `"3"` | **Invalid** — major-only. Use `adcp_major_version: 3` for major-precision pinning. |

SDKs that internally key bundles using the full semver patch-precision string (e.g. `"3.1.0-beta.1"` as a bundle key) MUST normalize to release-precision (`"3.1-beta.1"`) before emitting on the wire. Internal keying can stay exact; the wire is release-only by construction.

#### `build_version` canonical format

`build_version` MUST be a valid semver string with the patch component populated, optionally extended with pre-release and build-metadata segments per [semver §9–§10](https://semver.org/#spec-item-9):

```
build_version    = MAJOR "." MINOR "." PATCH [ "-" pre-release ] [ "+" build-metadata ]
```

Examples:
- `"3.1.2"` — minimum
- `"3.1.0-beta.3"` — pre-release
- `"3.1.2+scope3.deploy.4821"` — vendor build lineage
- `"3.1.0-beta.3+sha.a1b2c3d"` — both

Pattern: `^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$`

Buyers MUST NOT use `build_version` for negotiation. It exists solely so a buyer reporting an incident can name the seller's exact build, and so a seller can correlate a buyer-side report to a specific deployment lineage.

### 3. Resolution algorithm (server-side)

A server MUST honor `adcp_version` when present, falling back to `adcp_major_version` (integer) when only that is provided. When **both** are sent (the recommended steady state during 3.x — see §6), `adcp_version` takes precedence; if they disagree at the major level, the server MUST treat the request as cross-major and return `VERSION_UNSUPPORTED`.

| Client request | Server action |
|---|---|
| `adcp_version` present, exact match in `supported_versions` | Serve in that release. Echo on response. |
| `adcp_version` present, same major, server advertises both pre-release and release for the same `MAJOR.MINOR` (e.g. `["3.1-beta", "3.1"]`), buyer pins the release | Exact match wins; server MUST NOT silently downshift onto the pre-release. Serve `"3.1"`. |
| `adcp_version` present, same major, server's max release < client's pin | Serve highest supported release ≤ client's pin. Echo actual release. |
| `adcp_version` present, same major, no server release ≤ client's pin (gap or sub-min) | `VERSION_UNSUPPORTED`. The seller is not obligated to maintain validators for releases below its supported window. |
| `adcp_version` present, different major | `VERSION_UNSUPPORTED`. |
| both fields present, majors disagree | `VERSION_UNSUPPORTED` (treat as malformed). |
| `adcp_version` absent, `adcp_major_version` present | Serve highest supported release in that major. Echo response. |
| both absent | Serve in server's default release. Echo on response. |

In all non-error cases, the response's `adcp_version` is authoritative — it tells the client exactly what contract was served. Clients SHOULD validate the response against that release's schema, not against their pin. The seller's `adcp_version` on the response is the **release served**, never the seller's own latest release: if a 3.1 seller serves a 3.0 buyer at 3.0, the response echoes `"3.0"`.

#### Pre-release pins

Pre-release tags (e.g. `"3.1-beta"`) are matched **exactly** against `supported_versions`. They are not range-resolved:

- Buyer pins `"3.1-beta"` against server with `supported_versions: ["3.0", "3.1-beta"]` → match, serve `"3.1-beta"`.
- Buyer pins `"3.1-beta"` against server with `supported_versions: ["3.0", "3.1"]` → no match in same major (pre-release ≠ release), fall through to "no release ≤ client's pin" row → `VERSION_UNSUPPORTED`.
- Buyer pins `"3.1"` (release) against server with `supported_versions: ["3.0", "3.1-beta"]` → exact-match fails; same-major downshift → serve `"3.0"`.
- Buyer pins `"3.0"` against server with `supported_versions: ["3.1-beta"]` → no release ≤ `"3.0"` in same major → `VERSION_UNSUPPORTED`.

SDKs that internally key off pre-release tags MUST emit them verbatim on the wire. Servers MUST NOT downshift release pins onto pre-releases (a buyer asking for `"3.1"` should not be silently served `"3.1-beta"`).

### 4. Reuse `VERSION_UNSUPPORTED` with standardized error data

The existing `VERSION_UNSUPPORTED` error code stays. The `error.data` payload SHOULD follow `error-details/version-unsupported.json`:

```json
{
  "adcp_version": "4.0",
  "adcp_major_version": 4,
  "supported_versions": ["3.0", "3.1"],
  "supported_majors": [3],
  "build_version": "3.1.2+scope3.deploy.4821"
}
```

- `adcp_version` and `adcp_major_version` echo the buyer's failing pin (whichever was sent) so the client can correlate.
- `supported_versions` is **authoritative** — the client SHOULD select a value from this list and retry.
- `supported_majors` is deprecated, retained through 3.x.
- `build_version` is optional diagnostic metadata.

### 5. Capability advertisement

Augment the capabilities response with:

- `adcp.supported_versions: ["3.0", "3.1"]` — releases the server speaks. Authoritative for release-level negotiation. Pre-release tags appear inline (e.g. `["3.0", "3.1-beta"]` for a seller running only the 3.1 beta).
- `adcp.build_version: "3.1.2+scope3.deploy.4821"` — full semver build of the server's actual build. Optional, for operational visibility only.

The existing `adcp.major_versions: integer[]` is **deprecated** but kept through 3.x; servers MUST emit both during the deprecation window so legacy buyers stay functional. Removed in 4.0.

The existing `extensions.adcp.adcp_version` (capability-only string) is **deprecated** in favor of the new top-level `adcp_version` envelope field; kept as an alias through 3.x. Removed in 4.0.

Capability pre-flight is **optional optimization, not required discovery.** Clients MAY query capabilities before pinning; clients that don't can rely on `VERSION_UNSUPPORTED` as the discovery mechanism.

### 6. Deprecation of `adcp_major_version` and dual-emit during 3.x

The integer `adcp_major_version` field on requests is **deprecated** in favor of the release-precision `adcp_version` string. Removed in 4.0.

**Buyer obligations through 3.x:**
- A buyer SHOULD emit `adcp_version` once its SDK speaks release-precision pinning.
- A buyer that emits `adcp_version` SHOULD also emit `adcp_major_version` on the same request (with the major component of its pin), so legacy 3.x sellers that only read the integer continue to negotiate correctly.
- A buyer SHOULD prefer `adcp_version` once it has any signal that the seller speaks 3.1+ (response echo or capabilities).

**Seller obligations through 3.x:**
- A seller that reads `adcp_version` MUST honor it (cross-major → `VERSION_UNSUPPORTED`; in-major → resolution algorithm in §3). A 3.0 server that doesn't read the field is unaffected — `additionalProperties: true` makes it invisible.
- A seller SHOULD echo `adcp_version` on every response from 3.1 onward.
- A seller SHOULD emit `adcp.supported_versions` on capabilities responses; sellers MUST keep emitting `adcp.major_versions` (integer) through 3.x for backwards compatibility (i.e. you can't drop the legacy field early). Both go away in 4.0.
- When both `adcp_version` and `adcp_major_version` are present on a request and disagree at the major level, the server MUST return `VERSION_UNSUPPORTED` (treat as malformed).

The "MUST" obligations above are correctness rules: if you read the field, you have to act on it correctly; you can't drop the legacy field early. The "SHOULD" obligations above are emission requirements that the spec deliberately leaves at SHOULD through all of 3.x — see §migration for the rationale.

Mechanically: the shared `core/version-envelope.json` carries both fields as optional. Generated SDKs surface both as nullable; the SDK constructor sets both from a single user-provided release pin.

## Backwards compatibility

Fully additive on the wire:

- Servers that don't read `adcp_version` ignore it (allowed by `additionalProperties: true`) and fall back to `adcp_major_version` or default. Existing clients that don't read response `adcp_version` keep working.
- Capability responses keep emitting both `adcp.major_versions` (integer) and the new `supported_versions` (string) through 3.x.
- Existing `VERSION_UNSUPPORTED` callers see a richer `error.data` payload but the code is unchanged.

## Migration

The spec stays at SHOULD on both sides through all of 3.x (consistent with the 3.x stability guarantee that fields don't graduate optional → required within a major). The AdCP compliance grader, operated separately by AAO, is the lever that produces adoption pressure within 3.x.

| Phase | Spec — buyer | Spec — seller | Compliance grader |
|---|---|---|---|
| **3.1 (additive ship)** | SHOULD emit `adcp_version` (with `adcp_major_version` mirror). | SHOULD honor and echo `adcp_version`. SHOULD emit `supported_versions` on capabilities. | Advisory: reports presence on requests and responses. |
| **3.2** | (unchanged from 3.1) | (unchanged from 3.1) | Blocking failure when sellers don't echo `adcp_version` and don't emit `supported_versions` on capabilities. Sellers that want to be certified at 3.2 ship the echo. |
| **4.0** | MUST emit `adcp_version`. `adcp_major_version` removed. | MUST honor and echo `adcp_version`. `adcp.major_versions` and `extensions.adcp.adcp_version` removed. | Blocking failure on absence; legacy fields rejected. |

Cadence rationale: buyer-side pinning is only useful once sellers actually echo the served release. Rather than tightening the spec from SHOULD to MUST inside 3.x (which would dent the 3.x stability guarantee), the compliance grader carries that pressure — at 3.2, sellers that want certification ship response echo, and the migration moves. The wire change itself is zero-cost (additive, optional via `additionalProperties: true`); the grader is what produces real adoption.

## Out of scope (future RFCs)

- **Range negotiation.** Single-version pin only. A future RFC may add `min_adcp_version` / `max_adcp_version` if real demand surfaces.
- **Per-call override of an SDK-level pin.** SDK concern, not protocol concern.
- **Cross-major bridging.** Different major = different SDK = `VERSION_UNSUPPORTED`. Out of scope by design.

## SDK consequences (informational)

- Client SDKs add a constructor option (`adcpVersion` / `adcp_version`) accepting release-precision strings, that maps directly to the outbound `adcp_version` field. The SDK SHOULD also populate `adcp_major_version` from the major component of the pin for the duration of 3.x.
- The SDK's `COMPATIBLE_ADCP_VERSIONS` list is release strings (`["3.0", "3.1"]`).
- Validators key off the *response's* `adcp_version` (with the constructor pin as fallback when servers don't yet emit it).
- On `VERSION_UNSUPPORTED`, SDKs SHOULD raise a typed error exposing `error.data.supported_versions` rather than silently retrying — silent downshift changes wire shape under the caller. Auto-retry is an opt-in knob, not a default.
- Per-tool wire adapters become the escape hatch for the rare breaking-release case; envelope negotiation handles the steady state.

### Dual-emit timeline for SDKs

The SDK transition story for the deprecated `adcp_major_version` field is intentionally simple:

- **3.x branch of an SDK**: always emit both `adcp_version` and `adcp_major_version` on every request. This holds for the entire 3.x lifespan, including the v3 support window after 4.0 GA (12 months per the cadence policy). 3.x SDKs continue to dual-emit forever — they will not see the integer-removed schemas.
- **4.0 branch of an SDK**: emit `adcp_version` only. The 4.0 schemas no longer carry `adcp_major_version`, so dual-emit is a category error there.

SDK authors do not need to detect the seller's version to decide which fields to emit. The decision is determined by which spec major the SDK was built against. A 3.x SDK pointing at a 4.0 server will dual-emit; the 4.0 server reads `adcp_version` and ignores `adcp_major_version` (allowed by `additionalProperties: true`). A 4.0 SDK pointing at a 3.x server will emit only `adcp_version`; the 3.x server reads it directly (3.x sellers MUST honor `adcp_version` when present per §6).
