---
"adcontextprotocol": minor
---

spec(governance): rename body-level `status` on `check_governance` and `report_plan_outcome` responses to free the envelope `status` key (#4897).

Under MCP flat-on-the-wire serialization, the envelope task-status (`status`, drawn from `task-status.json`) and the body-level governance field share the same root key. The two enums overlap on `completed | canceled | rejected` and diverge elsewhere; whichever side wins on the wire, the other is silently destroyed and no validator catches it.

Resolution (WG-recommended Option A per the issue triage):

- **`governance/check-governance-response.json`** — `status` → `verdict`. Enum unchanged (`approved | denied | conditions`); `if/then` discriminator blocks now key on `verdict`. Renamed in `required[]`. Description threads (`findings`, `conditions`, `expires_at`) updated to reference the new name.
- **`governance/report-plan-outcome-response.json`** — `status` → `outcome_state`. Enum unchanged (`accepted | findings`); renamed in `required[]`. Description thread on `findings` updated.
- **`governance/get-plan-audit-logs-response.json`** — `entries[].status` → `entries[].verdict` (cascade for vocabulary consistency with check-governance-response). Other `status` fields (`plans[].status`, `governed_actions[].status`) are lifecycle states, not verdicts, and are left unchanged.

Docs swept (~25 example bodies + table descriptions):

- `docs/governance/overview.mdx`
- `docs/governance/campaign/tasks/check_governance.mdx` (7 examples + response table + prose)
- `docs/governance/campaign/tasks/report_plan_outcome.mdx` (5 examples + response table)
- `docs/governance/campaign/tasks/get_plan_audit_logs.mdx` (2 nested check entries)
- `docs/governance/campaign/audit-trail.mdx` (7 example bodies + field-tagging table)
- `docs/governance/campaign/specification.mdx` (3 examples)

Storyboards swept (the issue triage initially scoped this as "no yaml renames needed"; corrected during implementation):

- `static/compliance/source/specialisms/governance-spend-authority/index.yaml` — `field_present path: "status"` → `path: "verdict"`
- `static/compliance/source/specialisms/governance-spend-authority/denied.yaml` — both `field_present` and `field_value` assertions
- `static/compliance/source/specialisms/governance-delivery-monitor/index.yaml` — two `field_present` assertions
- `static/compliance/source/protocols/governance/index.yaml` — two `field_present` assertions plus a stale `outcome.expected` block referencing `status: recorded` (not in the enum) → corrected to `outcome_state: accepted`

Adopter impact:

- Wire-shape change on three experimental governance schemas (`x-status: experimental`).
- Buyers and sellers rename one property name per emitter / consumer; enum values are unchanged.
- SDK regen required for `@adcp/client`, `adcp-go`, and the Python client. Per the experimental-surface contract, this is a sanctioned 3.1 pre-GA adjustment.

Related:

- #4876 — envelope `status` REQUIRED (beta.2).
- #4895 — companion media-buy collision (separate PR).
- #4896 — per-task envelope fold. Once this PR lands, the carve-outs for `check-governance-response.json` and `report-plan-outcome-response.json` in #4896 can be removed; both schemas pick up the standard envelope fold cleanly.
