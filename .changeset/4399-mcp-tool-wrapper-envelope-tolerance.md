---
"adcontextprotocol": minor
---

spec(mcp,security): require MCP tool wrappers to tolerate envelope-level fields.

Buyer SDKs send envelope-level fields (`idempotency_key`, `context_id`, `context`, `governance_context`, `push_notification_config`) uniformly across all AdCP tool calls — including read-only tools that don't consume them. Buyers cannot know per-tool which envelope fields the seller's wrapper happens to declare, and the wire-level contract via `additionalProperties: true` on every published request schema permits them.

Some MCP server implementations apply stricter validation than the schema declares — FastMCP / Pydantic with declared signatures raises `unexpected_keyword_argument`, Zod `.strict()` rejects unknown keys, OpenAPI codegen sometimes injects `additionalProperties: false` into input models. The result: read tools like `get_products` reject calls when `idempotency_key` arrives in params, breaking cross-seller portability the protocol promises.

This is the server-side counterpart to the `additionalProperties: true` default — generalizing the principle already established for response validators in [`runner-output-contract.yaml` > `response_schema_validator_semantics`](https://github.com/adcontextprotocol/adcp/blob/main/static/compliance/source/universal/runner-output-contract.yaml) ("validator configuration MUST NOT contradict the schema's own `additionalProperties` declaration") to the request side.

Files:
- `docs/building/by-layer/L1/security.mdx` — new `#### Server-side tool wrapper conformance` subsection under §Idempotency (the most-affected envelope field). Concrete traps and fixes named for FastMCP/Pydantic, Zod/valibot, and OpenAPI codegen.
- `docs/building/by-layer/L0/mcp-guide.mdx` — new `### Server-side tool wrappers MUST tolerate envelope fields` subsection under §MCP-Specific Considerations, cross-linking to the security.mdx normative rule. Concrete traps and one-line fixes for the three common stacks.

Confirmed pre-existing in the wild — issue filer (#4399) hit it in production against a real seller, fixed in the seller's Wave 23.20 by adding `idempotency_key: str | None = None` to read-tool wrapper signatures.

Closes #4399.
