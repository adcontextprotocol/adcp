---
title: "Transport Error Mapping for MCP and A2A"
description: "Proposal for carrying AdCP structured errors (error codes, recovery classifications, retry_after) over MCP and A2A transports."
"og:title": "AdCP — Transport Error Mapping Proposal"
---

# Proposal: Transport Error Mapping for MCP and A2A

**Status**: Accepted
**Issue**: [#1560](https://github.com/adcontextprotocol/adcp/issues/1560)
**Normative spec**: [Transport Error Mapping](/docs/building/implementation/transport-errors)

## Problem

AdCP defines a structured error model with 20 standard error codes, recovery classifications (`transient` / `correctable` / `terminal`), and fields like `retry_after`. When an AdCP agent is accessed over MCP or A2A, this structure is lost.

A rate-limited request today returns:

```json
{"jsonrpc": "2.0", "id": null, "error": {"code": -32000, "message": "Rate limit exceeded. Please try again later."}}
```

The client cannot determine:
- That this is a `RATE_LIMITED` error (vs. any other `-32000`)
- How long to wait (`retry_after`)
- Whether to retry, fix the request, or escalate (`recovery`)

Clients must pattern-match on error message strings, which is fragile, language-dependent, and loses the structured data that AdCP already defines.

## What AdCP Already Has

The error schema (`/schemas/latest/core/error.json`) is well-designed:

| Field | Purpose |
|---|---|
| `code` | Machine-readable (20 standard codes, extensible) |
| `message` | Human-readable |
| `retry_after` | Seconds to wait (transient errors) |
| `recovery` | `transient` / `correctable` / `terminal` |
| `field` | Which request field caused the error |
| `suggestion` | Suggested fix |
| `details` | Arbitrary additional context |

The gap is how to carry this over MCP and A2A transports.

## Design Principle

AdCP errors are **application-layer** errors. They belong in the tool/task response, not in the JSON-RPC error object.

| Layer | Examples | Channel |
|---|---|---|
| Transport | Connection refused, malformed JSON-RPC, internal crash | JSON-RPC `error` object |
| Application | `RATE_LIMITED`, `BUDGET_TOO_LOW`, `CREATIVE_REJECTED` | Tool/task response body |

This separation matters because:
- Application errors carry structured recovery data that JSON-RPC `error.data` was not designed for
- Transport errors are handled by protocol libraries; application errors are handled by business logic
- MCP and A2A have different response envelopes but the same application-layer semantics

## MCP Binding

### Tool-Level Errors (Standard Path)

Return a successful MCP response with `isError: true` and the AdCP error in the response body. This is the path for all AdCP error codes — the tool executed, understood the request, and is returning a structured error.

```json
{
  "content": [{"type": "text", "text": "Rate limit exceeded. Retry in 5 seconds."}],
  "isError": true,
  "structuredContent": {
    "adcp_error": {
      "code": "RATE_LIMITED",
      "message": "Request rate exceeded",
      "retry_after": 5,
      "recovery": "transient"
    }
  }
}
```

**Why `structuredContent`?** MCP's `structuredContent` field (added in MCP 2025-03-26) is designed for machine-readable response data alongside human-readable `content`. Using it means AdCP errors are accessible to both LLMs (via `content` text) and programmatic clients (via `structuredContent`).

**Why `adcp_error` key?** Namespacing under `adcp_error` avoids collisions with other structured content that tool responses may include (e.g., `products`, `media_buy`). A single, predictable key simplifies client detection.

**MCP version compatibility:** `structuredContent` requires MCP 2025-03-26 or later. Servers running older MCP versions SHOULD serialize the AdCP error as a JSON string in `content[0].text` alongside `isError: true`. Clients will parse this via the string-matching fallback (detection order step 4).

### Transport-Level Rate Limits (Infrastructure Path)

When rate limiting is enforced by infrastructure *before* tool dispatch (e.g., an API gateway or MCP middleware), the tool never executes. Use JSON-RPC error code `-32029` with the AdCP error in `data`:

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "adcp_error": {
        "code": "RATE_LIMITED",
        "retry_after": 5,
        "recovery": "transient"
      }
    }
  }
}
```

**Why `-32029`?** JSON-RPC reserves `-32000` to `-32099` for server-defined errors. `-32029` is a specific code for rate limiting, making it distinguishable from generic server errors. This is preferable to overloading `-32000` for all error types.

**When does this path apply?** Only when infrastructure rejects the request before the AdCP tool runs. If the tool itself detects rate limiting (e.g., by querying a seller API), it uses the tool-level path above.

### Additional Transport-Level Codes

For other infrastructure-enforced errors, reserve:

| JSON-RPC Code | AdCP Error Code | When |
|---|---|---|
| `-32029` | `RATE_LIMITED` | Infrastructure rate limit before tool dispatch |
| `-32028` | `AUTH_REQUIRED` | Auth rejected by middleware before tool dispatch |
| `-32027` | `SERVICE_UNAVAILABLE` | Infra health check fails, upstream down |

All other AdCP error codes use the tool-level path exclusively.

## A2A Binding

### Failed Tasks with Structured Errors

Use `status: "failed"` with the AdCP error in an artifact `DataPart`, plus a `TextPart` for backward compatibility:

```json
{
  "id": "task_456",
  "status": {
    "state": "failed",
    "timestamp": "2025-01-22T10:30:00Z"
  },
  "artifacts": [{
    "name": "task_result",
    "parts": [
      {
        "kind": "text",
        "text": "Rate limit exceeded. Retry in 5 seconds."
      },
      {
        "kind": "data",
        "data": {
          "adcp_error": {
            "code": "RATE_LIMITED",
            "message": "Request rate exceeded",
            "retry_after": 5,
            "recovery": "transient"
          }
        }
      }
    ]
  }]
}
```

This follows the existing A2A response format conventions:
- Final states (`completed`, `failed`) use `.artifacts` for data
- `TextPart` provides human-readable context for LLM clients
- `DataPart` provides machine-readable error for programmatic clients

**Relationship to the "no wrappers" rule.** The [A2A Response Format](/docs/building/integration/a2a-response-format) requires that `DataPart` content be the direct AdCP response payload, not wrapped in framework objects. The `adcp_error` key is an intentional exception for failed tasks: unlike success responses where the DataPart contains task-specific data (e.g., `products`, `media_buy_id`), a failed task's DataPart contains only the error. The `adcp_error` key acts as a type discriminator so clients can distinguish error payloads from success payloads without relying on status alone. This is consistent with the existing `errors` array pattern used for partial failures in success responses.

### Error MIME Type

As an alternative signal, A2A agents MAY use `application/vnd.adcp.error+json` as the MIME type on the `DataPart`:

```json
{
  "kind": "data",
  "data": {
    "adcp_error": { "code": "RATE_LIMITED", "retry_after": 5, "recovery": "transient" }
  },
  "metadata": {
    "mimeType": "application/vnd.adcp.error+json"
  }
}
```

This is optional. Clients MUST NOT require the MIME type — presence of `adcp_error` key in the `DataPart` is sufficient.

## Client Detection Order

Clients MUST check for AdCP errors in this order:

1. **`structuredContent.adcp_error`** — MCP tool-level error (structured, preferred)
2. **`artifacts[].parts[].data.adcp_error`** — A2A task-level error
3. **JSON-RPC `error.data.adcp_error`** — Transport-level error (MCP infrastructure)
4. **String pattern matching on `error.message`** — Fallback for servers that don't implement this proposal

In practice, implementations will branch on transport type first (MCP vs. A2A) and only check the relevant paths. The unified function below is a conceptual illustration:

```javascript
function extractAdcpError(response) {
  // 1. MCP structuredContent (tool-level)
  if (response.structuredContent?.adcp_error) {
    return response.structuredContent.adcp_error;
  }

  // 2. A2A artifact DataPart
  const dataPart = response.artifacts?.[0]?.parts?.find(p => p.kind === 'data');
  if (dataPart?.data?.adcp_error) {
    return dataPart.data.adcp_error;
  }

  // 3. JSON-RPC error.data (transport-level)
  if (response.error?.data?.adcp_error) {
    return response.error.data.adcp_error;
  }

  // 4. Fallback: no structured error available
  return null;
}
```

## Recovery Behavior

Once an AdCP error is extracted, clients apply recovery based on the `recovery` field:

| Recovery | Client Behavior |
|---|---|
| `transient` | Retry after `retry_after` seconds (or exponential backoff if absent) |
| `correctable` | Surface `suggestion` and `field` to caller, do not auto-retry |
| `terminal` | Surface error to human operator, do not retry |

For unknown `recovery` values (forward compatibility), treat as `terminal`.

## Implementation in `@adcp/client`

The `@adcp/client` library already implements the standard error codes lookup table (`STANDARD_ERROR_CODES`) and recovery classification functions (`getErrorRecovery`, `isStandardErrorCode`). The client's MCP protocol handler (`callMCPTool`) currently extracts errors from `content` text only.

Changes needed:

1. **MCP response parsing**: Check `structuredContent.adcp_error` before falling back to text extraction
2. **MCP error parsing**: Check `error.data.adcp_error` for transport-level errors
3. **A2A response parsing**: Check `artifacts[].parts[].data.adcp_error` for failed tasks
4. **Retry logic**: Use `retry_after` from structured error when available

These changes are backward-compatible. Servers that don't implement this proposal will continue to work through the existing text-extraction fallback.

## Open Questions

### 1. Should `-32029` be proposed upstream to MCP spec?

Rate limiting is common across MCP servers, not AdCP-specific. A standard code would benefit the ecosystem. **Recommendation**: Yes, propose to MCP working group after validating the pattern with AdCP implementations.

### 2. Should `retry_after` also be an HTTP header?

For StreamableHTTP transport, HTTP-aware middleware could handle rate limiting without parsing the JSON body. **Recommendation**: Yes, include `Retry-After` HTTP header alongside the JSON field for StreamableHTTP. This is additive and follows HTTP conventions.

### 3. A2A task state for transient errors

Should a rate-limited task be `failed`? A2A doesn't define a `retryable` state. **Recommendation**: Use `failed` with `adcp_error.recovery: "transient"` to signal retryability. Proposing a new A2A TaskState is out of scope for this proposal.

### 4. Should AdCP reserve additional JSON-RPC codes?

**Recommendation**: Reserve `-32029` through `-32027` as listed above. Do not reserve codes for application-layer errors — those use the tool-level path. Three transport-level codes (rate limit, auth, unavailable) cover the infrastructure cases.

## Compatibility

| Component | Impact |
|---|---|
| Existing MCP servers | No change required. Servers can adopt incrementally. |
| Existing A2A servers | No change required. Failed tasks already use artifacts. |
| `@adcp/client` | Backward-compatible additions to response parsing. |
| Servers without this proposal | Clients fall back to string matching (step 4). |

## Security Considerations

Error responses flow through LLM context (MCP `content` text is consumed by LLMs, A2A `TextPart` is displayed to users). Every field in the error envelope is client-facing.

### Constraints on Error Fields

Implementations MUST NOT include the following in error fields (`message`, `suggestion`, `details`):
- Internal service names, hostnames, or IP addresses
- Database error text, SQL fragments, or query plans
- Stack traces or file paths
- Upstream API responses from internal services
- Credentials, tokens, or session identifiers

The `details` field (`{"type": "object", "additionalProperties": true}`) is intentionally open-ended for domain-specific context (e.g., `available_countries`, `minimum_budget`). Implementations must treat it as a client-facing field and audit its contents accordingly.

### Suggestion Field Boundaries

The `suggestion` field SHOULD provide generic correction guidance (e.g., "Increase budget to meet minimum") rather than revealing specific internal thresholds, valid identifiers, or resource existence. Avoid suggestions that confirm or deny the existence of resources the caller has not already accessed.

### Timing Side Channels

Implementations SHOULD return consistent `retry_after` values that reflect the caller's rate limit state, not the target resource's properties, to avoid leaking resource-specific information through timing variation.

### Transport-Level Code Granularity

The reserved JSON-RPC codes (`-32029`, `-32028`, `-32027`) allow clients to distinguish infrastructure error types. This is analogous to HTTP status codes (401 vs. 429 vs. 503). Implementations that prefer to minimize endpoint fingerprinting MAY collapse these into a single generic code at the cost of less granular client recovery.

## References

- AdCP error schema: `/schemas/latest/core/error.json`
- AdCP error codes: `/schemas/latest/enums/error-code.json`
- MCP `structuredContent`: [MCP Specification 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26)
- A2A response format: [A2A Response Format](/docs/building/integration/a2a-response-format)
- Error handling guide: [Error Handling](/docs/building/implementation/error-handling)
