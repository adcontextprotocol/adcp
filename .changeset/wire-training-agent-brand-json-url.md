---
---

Wire the training agent to emit `identity.brand_json_url` on `get_adcp_capabilities`, list it in the AdCP-domain `brand.json` `agents[]`, and ship a runnable end-to-end resolver script that exercises the 8-step keys-from-agent-URL discovery chain documented in security.mdx.

Round-4 expert fixes to the discovery chain prose:
- Step 1 calls `get_adcp_capabilities` via the agent's transport (MCP `tools/call` / A2A skill invocation), not raw HTTP `GET` on the agent URL.
- Origin comparisons throughout (step 7 `key_origins` consistency, eTLD+1 binding) MUST canonicalize to ASCII-lowercase + IDNA-2008 A-label form before byte-equality.
- Pseudocode shows budgets (`MAX_CAPABILITIES_BYTES`, `MAX_BRAND_JSON_BYTES`, `MAX_JWKS_BYTES`, `connect: 5s`, `total: 10s`, `maxRedirects: 0`) on every fetch, not just brand.json.
- Strict-JSON parse with duplicate-key rejection on brand.json, plus a new `request_signature_brand_json_malformed` error code.
- PSL pinning called out per language (`tldts` / `publicsuffixlist` / `golang.org/x/net/publicsuffix` with vendored snapshot; no runtime fetch).
- Step 8 cross-ref to verifier checklist now points at "step 8+" since `keyid` resolution is the discovery preamble itself.
- Reference-implementations paragraph names result-shape fields per language (`agent_url` / `AgentURL`, `brand_json_url` / `BrandJSONURL`, etc.) so callers know what to expect from each SDK.
- Python and Go CLIs install a top-level `adcp` binary (Python via `[project.scripts]` console_scripts, Go binary distinct from module path).

`x-adcp-validation` schema-extensions doc: `required_when` is an object wrapping `any_of` / `all_of` (mirroring JSON Schema's anyOf/allOf precedent), not a bare array. TODO link replaced with [adcontextprotocol/adcp#3827](https://github.com/adcontextprotocol/adcp/issues/3827) tracking migration of remaining prose-rule fields.
