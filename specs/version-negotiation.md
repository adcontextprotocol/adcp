# AdCP RFC: Release-precision protocol version negotiation

## Summary

Add `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level envelope field on every request and response. Clients send the release they're pinned to; servers echo the release they actually served. Augments the existing `adcp_major_version` (integer per-request) with finer precision and adds **response-side echo**, which the spec lacks today. Transport-uniform across MCP (streamable-HTTP and stdio) and A2A.

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

## Spec changes

### 1. New protocol envelope field

Define a meta-schema `core/protocol-envelope.json`:

```json
{
  "$id": "/schemas/core/protocol-envelope.json",
  "type": "object",
  "properties": {
    "adcp_version": {
      "type": "string",
      "description": "Release-precision AdCP version this party is operating at (VERSION.RELEASE, e.g. \"3.0\", \"3.1\", \"3.1-beta\"). On a request: the buyer's release pin. On a response: the release the seller actually served. Patches are not negotiated — they don't change the wire contract by definition; surface them as build_version on capabilities for operational visibility.",
      "pattern": "^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$",
      "examples": ["3.0", "3.1", "3.1-beta", "3.1-rc.1"]
    }
  }
}
```

The field has the same name on both sides of the wire — semantics fall out of context (request body vs response body).

Placement per transport:

- **MCP / JSON-RPC:** `adcp_version` at the top of `params` (request), `result` (response), `error.data` (error).
- **A2A:** `adcp_version` at the top of the AdCP message body.

### 2. Granularity: release, not patch

The negotiation field uses **release precision** (`"3.0"`, `"3.1"`), not patch (`"3.1.2"`):

- Per the spec's own three-tier model, **patch** = bug fixes, always safe to upgrade, no contract change. Negotiation is about contract compatibility — patches don't qualify.
- Patch precision on the wire would force every server to declare its build patch; every client's `supported_versions` list would churn on releases that don't affect interop.

For operational visibility — "which build patch is this server on" — servers MAY include `build_version` (full VERSION.RELEASE.PATCH, e.g. `"3.1.2"`) in the capabilities response as advisory metadata. Useful for incident triage; not part of the contract.

### 3. Resolution algorithm (server-side)

A server MUST honor `adcp_version` when present and SHOULD fall back to `adcp_major_version` (integer) when only that is provided:

| Client request | Server action |
|---|---|
| `adcp_version` present, exact match | Serve in that release. Echo on response. |
| `adcp_version` present, same major, server's max release < client's pin | Serve highest supported release ≤ client's pin. Echo actual release. |
| `adcp_version` present, same major, server's min release > client's pin | Serve client's pin (server downshifts to client's contract). |
| `adcp_version` present, different major | `VERSION_UNSUPPORTED` error. |
| `adcp_version` absent, `adcp_major_version` present | Serve highest supported release in that major. Echo response. |
| both absent | Serve in server's default release. Echo on response. |

In all non-error cases, the response's `adcp_version` is authoritative — it tells the client exactly what contract was served. Clients SHOULD validate the response against that release's schema, not against their pin.

### 4. Reuse VERSION_UNSUPPORTED with standardized error data

The existing `VERSION_UNSUPPORTED` error code stays. Standardize the `error.data` payload:

```json
{
  "adcp_version": "3.0",
  "supported_majors": [3],
  "supported_versions": ["3.0", "3.1"],
  "build_version": "3.1.2"
}
```

`supported_versions` is authoritative; `build_version` is optional diagnostic metadata.

### 5. Capability advertisement

Augment the capabilities response with:

- `supported_versions: ["3.0", "3.1"]` — releases the server speaks. Authoritative for release-level negotiation.
- `build_version: "3.1.2"` — full VERSION.RELEASE.PATCH of the server's actual build. Optional, for operational visibility only.

The existing `adcp.major_versions: integer[]` is **deprecated** but kept through 3.x; servers SHOULD emit both. Removed in 4.0.

The existing `extensions.adcp.adcp_version` (capability-only string) is **deprecated** in favor of the new top-level `adcp_version` envelope field; kept as an alias through 3.x. Removed in 4.0.

Capability pre-flight is **optional optimization, not required discovery.** Clients MAY query capabilities before pinning; clients that don't can rely on `VERSION_UNSUPPORTED` as the discovery mechanism.

### 6. Deprecation of `adcp_major_version`

The integer `adcp_major_version` field on requests is **deprecated** in favor of the release-precision `adcp_version` string. Servers MUST continue to honor it through 3.x for backwards compat. Removed in 4.0.

Mechanically: schemas keep both fields through 3.x. The string field's description marks the integer as deprecated and points to the new field.

## Backwards compatibility

Fully additive on the wire:

- Servers that don't read `adcp_version` ignore it (allowed by `additionalProperties: true`) and fall back to `adcp_major_version` or default. Existing clients that don't read response `adcp_version` keep working.
- Capability responses keep emitting both `adcp.major_versions` (integer) and the new `supported_versions` (string) through 3.x.
- Existing `VERSION_UNSUPPORTED` callers see a richer `error.data` payload but the code is unchanged.

## Migration

| Phase | Spec status | Compliance grader |
|---|---|---|
| 3.1 (additive ship) | RECOMMENDED on both sides | Reports presence as advisory |
| 3.2 | SHOULD implement on both sides | Non-blocking warning on absence |
| 4.0 | MUST implement on both sides; legacy `adcp_major_version`, `adcp.major_versions`, and `extensions.adcp.adcp_version` removed | Blocking failure on absence |

## Out of scope (future RFCs)

- **Range negotiation.** Single-version pin only. A future RFC may add `min_adcp_version` / `max_adcp_version` if real demand surfaces.
- **Per-call override of an SDK-level pin.** SDK concern, not protocol concern.
- **Cross-major bridging.** Different major = different SDK = `VERSION_UNSUPPORTED`. Out of scope by design.

## SDK consequences (informational)

- Client SDKs add a constructor option (`adcpVersion` / `adcp_version`) accepting release-precision strings, that maps directly to the outbound `adcp_version` field.
- The SDK's `COMPATIBLE_ADCP_VERSIONS` list is release strings (`["3.0", "3.1"]`).
- Validators key off the *response's* `adcp_version` (with the constructor pin as fallback when servers don't yet emit it).
- Per-tool wire adapters become the escape hatch for the rare breaking-release case; envelope negotiation handles the steady state.
