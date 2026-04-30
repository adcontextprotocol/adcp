---
---

Anthropic tool_use sweep across structured-extraction services. Completes the
pattern adoption that #3396 (smart-paste property parse) started: each
migrated caller defines a tool with `input_schema`, sets `tool_choice` to
force it, and reads `tool_use.input` directly — no `JSON.parse` of free-form
text, no fence-stripping regex, no prompt-injection surface from text-output
parsing.

Converted callers (one commit each):

- `server/src/services/property-enhancement.ts` — `analyze_property` tool
  (publisher assessment)
- `server/src/services/brand-classifier.ts` — `classify_brand` tool (Keller
  architecture; auth-relevant via autoLinkByVerifiedDomain)
- `server/src/services/prospect-triage.ts` — `assess_prospect` tool
  (action / owner / priority / company_type enums)
- `server/src/services/brand-enrichment.ts` — `discover_sub_brands` tool
  (house expansion)

Each migration ships a unit test pinning: tool definition with the right
`input_schema` enums, `tool_choice` forces the tool, defensive fall-through
when the model returns no `tool_use` block, and the runtime allowlist still
bounds the result.
