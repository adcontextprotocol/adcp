---
"adcontextprotocol": patch
---

spec(storyboard-schema): add optional storyboard-level `default_agent` field

Closes #3894. Adds an optional top-level `default_agent: <key>` field to the storyboard authoring schema (`static/compliance/source/universal/storyboard-schema.yaml`).

`default_agent` is the logical name (`sales`, `governance`, `creative`, etc.) the multi-agent runner falls back to when a step has no `step.agent` override and the tool has no unique specialism claimant in the runtime agents map. Resolved against the `agents` option passed to `runStoryboard({ agents: {…} })` — see adcp-client#1066 and adcp-client#1355.

The runner already accepts `default_agent` via run-options. This change lets storyboard authors encode the topology intent in YAML once, rather than re-asserting `--default-agent sales` on every CI invocation. Cross-domain tools (`sync_creatives`, `list_creative_formats`, `comply_test_controller`) become deterministic without per-step `agent:` overrides.

Strictly additive and backward-compatible:
- Single-agent runs ignore the field (precedent: `requires_scenarios`, `controller_seeding`).
- Existing 3.0.x storyboards keep working unchanged.
- Pre-existing run-options `default_agent` keeps the lower-precedence fallback slot.

Resolution order (runner contract):
1. Step-level `agent:` override.
2. Unique specialism claimant in the runtime agents map.
3. Storyboard-level `default_agent` (this field).
4. Run-options `default_agent`.
5. Fail-fast (`unrouted_step`).

Mirrors the `provides_state_for` precedent (#3775) for adding optional storyboard-schema fields on 3.0.x — small, additive authoring affordances that adopters need today and that don't bind 3.0 wire shape.
