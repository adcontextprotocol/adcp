---
---

Migrate the smart-paste property parse endpoint to Anthropic tool_use with `input_schema`. The model now emits typed args matching the schema rather than free-form text we have to parse — this structurally eliminates the prompt-injection surface that the prior `<content>...</content>` wrapper + `</content>` escape was trying (theatrically) to defend. Deletes the JSON-fence-stripping regex and the JSON.parse path entirely. Output filter (DNS 253-char cap + type allowlist + lowercase + 500-property cap) remains as defense-in-depth.

Tool definition includes the property type allowlist as a JSON-schema enum, so the SDK constrains type values at the schema layer in addition to the runtime filter. `tool_choice: { type: 'tool', name: 'extract_properties' }` forces the model to call the tool — a defensive fall-through still returns the warning if the SDK shape changes upstream and no tool_use block lands.

Tests: 26 cases pin tool definition, tool_choice forcing, schema enum, output filtering, URL streaming branches, auth/SSRF, truncation, and a hostile-URL test confirming `<content>` wrappers are gone and tool_choice still forces extract_properties. Validated end-to-end with Playwright against real Claude haiku.
