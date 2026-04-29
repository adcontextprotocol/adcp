# AdCP RFC: Bidirectional protocol version negotiation

## Summary

Promote AdCP protocol version to a first-class, top-level field on every request and response. Clients send the version they're pinned to; servers echo the version they actually served. Negotiation operates at **minor precision** (`"3.0"`, `"3.1"`); patches are operational metadata, not part of the contract. Transport-agnostic — works identically on MCP (streamable-HTTP and stdio) and A2A. Replaces the current `extensions.adcp.adcp_version` capability-only signal with envelope-level negotiation.

## Motivation

Today, AdCP wire version is a property of the *server*: a server speaks one version, advertised once on the capabilities response under `extensions.adcp.adcp_version`. Clients have no per-call way to declare which version they're built against, and servers have no signal to shape responses accordingly. This blocks:

- **Per-instance version pinning in client SDKs** (Stripe model). Buyers can't say "this client speaks 3.0, regardless of what newer servers I might call."
- **Multi-tenant deployments** where one seller's clients are on 3.0 and another's are on 3.1.
- **Compliance harnesses** that exercise cross-version interop in one process.
- **Controlled rollout** of breaking minors. With no version on the wire, every server upgrade is a coordinated buyer migration.

The signal must be:

- **Transport-uniform.** HTTP headers (Stripe's choice) don't exist on stdio-MCP. Excluded.
- **Not in `extensions.*`.** Version is meta-protocol, not a feature. Extensions are optional, namespace-scoped feature plumbing; version is underneath features and determines which apply. A versioned extension surface can't carry the signal that selects its own version.
- **Top-level on the AdCP payload.** First-class field on every request and response schema.

## Spec changes

### 1. New protocol envelope field

Define a meta-schema `core/protocol-envelope.json`:

```json
{
  "$id": "core/protocol-envelope.json",
  "type": "object",
  "properties": {
    "adcp_version": {
      "type": "string",
      "description": "Minor-precision AdCP version this party is operating at. On a request: the client's pin. On a response: the version the server actually served. Patches are not negotiated — they don't change the wire contract by definition.",
      "pattern": "^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$",
      "examples": ["3.0", "3.1", "3.1-beta", "3.1-rc.1"]
    }
  }
}
```

Every tool's request schema, response schema, and error response composes with this envelope via `allOf`. The `allOf` injection is **automatic at schema build time** — schema authors do not hand-declare the field per tool. One source of truth, no copy-paste drift across ~30 tool schemas.

The field has the same name on both sides of the wire — semantics are "the version this party is operating at," symmetric.

Placement per transport:

- **MCP / JSON-RPC:** `adcp_version` at the top of `params` (request), `result` (response), `error.data` (error).
- **A2A:** `adcp_version` at the top of the AdCP message body.

### 2. Granularity: minor, not patch

The negotiation field uses **minor precision** (`"3.0"`, `"3.1"`), not patch (`"3.0.1"`). Rationale:

- Semver says patch = no contract change. Negotiation is about contract compatibility. If a patch ships a wire-visible change, it shouldn't have been a patch — bump minor.
- Patch precision on the wire is operational noise: every server has to declare its build patch; every client's `supported_versions` list churns on releases that don't affect interop.

Pre-release tags hang off minor: `"3.1-beta"`, `"3.1-rc.1"`.

For operational visibility — "which build patch is this server on" — servers MAY include `build_version` (full semver, e.g. `"3.0.1"`) in the capabilities response as advisory metadata. Useful for incident triage; not part of the contract.

### 3. Resolution algorithm (server-side)

| Client `adcp_version` on request | Server action |
|---|---|
| absent | Serve in server's default version. Response `adcp_version` reflects what was served. |
| supported exactly | Serve in that version. |
| same major, server's max < client's pin | Serve highest supported version ≤ client's pin. Response echoes actual served version. |
| same major, server's min > client's pin | Serve client's pin (server downshifts to client's contract). |
| different major | Error response, code `version_mismatch`. |

In all non-error cases, the response's `adcp_version` is authoritative — it tells the client exactly what contract was served. Clients validate the response against that version's schema, not against their pin.

### 4. New error code

`version_mismatch` — client pin's major doesn't match any major the server supports. Client-side error class. `error.data` includes:

```json
{
  "adcp_version": "3.0",
  "supported_majors": [3],
  "supported_versions": ["3.0", "3.1"],
  "build_version": "3.0.1"
}
```

`supported_versions` is authoritative; `build_version` is optional diagnostic metadata.

### 5. Capability advertisement

Augment the capabilities response with:

- `supported_versions: ["3.0", "3.1"]` — minors the server speaks. Authoritative.
- `build_version: "3.0.1"` — full semver of the server's actual build. Optional, for operational visibility only.

The existing `extensions.adcp.adcp_version` on capabilities is **deprecated** but kept as an alias of the new top-level `adcp_version` through all of 3.x. Removed in 4.0.

Capability pre-flight is **optional optimization, not required discovery.** Clients MAY query capabilities before pinning; clients that don't can rely on `version_mismatch` as the discovery mechanism.

## Backwards compatibility

Fully additive on the wire:

- Servers that don't implement negotiation ignore the request's `adcp_version` (allowed by `additionalProperties: true`) and respond in their default version. Existing clients that don't read response `adcp_version` keep working.
- Capability responses keep emitting the legacy `extensions.adcp.adcp_version` alongside the new top-level field through 3.x.
- New schemas (3.1+) MUST declare `adcp_version` in their request/response shape via the auto-injected envelope `allOf`. Existing 3.0 schemas don't need re-versioning to land negotiation — `additionalProperties: true` covers it.

## Migration

| Phase | Spec status | Compliance grader |
|---|---|---|
| 3.1 (additive ship) | RECOMMENDED on both sides | Reports presence as advisory |
| 3.2 | SHOULD implement on both sides | Non-blocking warning on absence |
| 4.0 | MUST implement on both sides; legacy `extensions.adcp.adcp_version` removed | Blocking failure on absence |

## Out of scope (future RFCs)

- **Range negotiation.** Single-version pin only. A future RFC may add `min_adcp_version` / `max_adcp_version` if real demand surfaces.
- **Per-call override of an SDK-level pin.** SDK concern, not protocol concern.
- **Cross-major bridging.** Different major = different SDK = `version_mismatch`. Out of scope by design.

## SDK consequences (informational)

- Client SDKs add a constructor option (`adcpVersion` / `adcp_version`) accepting minor-precision strings, that maps directly to the outbound `adcp_version` field.
- The SDK's `COMPATIBLE_ADCP_VERSIONS` list collapses to minors (`["3.0", "3.1"]`) — patch-level pinning is removed.
- Validators key off the *response's* `adcp_version` (with the constructor pin as the fallback when servers don't yet emit it).
- Per-tool wire adapters become the escape hatch for the rare breaking-minor case; envelope negotiation handles the steady state.
