---
"adcontextprotocol": minor
---

spec(request-signing): add `protocol_methods_*` namespace to `request_signing` capability; widen test-agent strict route to enforce it (closes #4318, #4314)

`request_signing.supported_for` / `required_for` carry **AdCP protocol operation names** (`create_media_buy`, `update_media_buy`, …). They have always been silent on **JSON-RPC protocol methods** like `tasks/cancel` and `tasks/get` — methods that traverse the same authenticated channel as `tools/call` (auto-registered by MCP and defined by A2A 0.3.0 §7.x), but are not AdCP operations and MUST NOT be conflated with the AdCP-tool namespace per the existing normative rule at `security.mdx:927`. Buyers signing `tasks/cancel` on abort had no spec-grounded way to know whether the seller's verifier covered it; the only defensible default was to over-sign on best-effort.

This change adds three sibling fields to `request_signing` for sellers to declare verifier coverage of protocol methods:

```jsonc
{
  "request_signing": {
    "supported": true,
    "supported_for": ["create_media_buy", "update_media_buy"],
    "required_for": ["create_media_buy"],
    "protocol_methods_supported_for": ["tasks/cancel", "tasks/get"],
    "protocol_methods_required_for": ["tasks/cancel"]
  }
}
```

Schema enforces the namespace split via `pattern: "/"` on items — JSON-RPC method strings (containing `/`) MUST appear here; AdCP tool names (no `/`) MUST appear in `supported_for` / `required_for`. `protocol_methods_required_for` is `subset_of` `protocol_methods_supported_for`; `protocol_methods_warn_for` is `disjoint_with` `protocol_methods_required_for` and `subset_of` `protocol_methods_supported_for` (mirrors AdCP-namespace rules). `identity.brand_json_url` is now `required_when` any of the new fields is non-empty.

Normative text added to `docs/building/by-layer/L1/security.mdx`:
- The `protocol_methods_*` arrays are matched against the JSON-RPC envelope's `method` field, not the `tools/call` `params.name`.
- The same RFC 9421 covered components apply to JSON-RPC method calls (`@target-uri`, `@method`, `content-digest` per the seller's `covers_content_digest` policy, `authorization` when present).
- Buyers MUST NOT infer protocol-method coverage from `supported_for` / `required_for`.

`test-agent.adcontextprotocol.org` strict route (`/<tenant>/mcp-strict`) is widened to enforce the new bucket: `STRICT_REQUIRED_FOR` adds `update_media_buy` and `sync_creatives` (so a buyer that signs the initial create but forgets follow-on mutations gets a 401 instead of a silent green light), and a new `STRICT_PROTOCOL_METHODS_REQUIRED_FOR = ['tasks/cancel']` constant feeds the SDK verifier through a new namespace-aware `mcpOperationResolver`. The wire response from `get_adcp_capabilities` splits the bundle so AdCP tool names emit on `required_for` and JSON-RPC methods emit on `protocol_methods_required_for`. Closes the original `tasks/cancel`-on-abort regression-test ask in adcp-client#1617 Phase 2.

The earlier #4314 proposal of an `X-Test-Require-Signing` per-session header is **not** adopted: per the triage, header-driven per-session enforcement contradicts `security.mdx:927` (declaration-enforcement coherence) and the SDK's verifier architecture (singleton capability objects, eagerly-built authenticators). Strict-route enforcement on `/mcp-strict` is the spec-coherent path.

No `VerifierCapability` (SDK type) shape change — the SDK's flat `required_for` array remains; namespace separation lives on the wire and in storyboard runners, not in the verifier match step.
