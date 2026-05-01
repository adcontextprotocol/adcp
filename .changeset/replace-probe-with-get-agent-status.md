---
---

Replace `probe_adcp_agent` with `get_agent_status`. The probe tool made a server-to-self HTTP POST through `callApi`, which our CSRF middleware rejected because `/api/adagents/validate-cards` isn't in the exempt list. As a result every probe call returned `Error: CSRF validation failed` against perfectly healthy agents — including the public test agent and members' production agents — and led Addie to interpret a self-loopback rejection as a platform-wide outage (escalation #297).

Rather than patch the loopback path, drop the parallel implementation. `get_agent_status` reads the same cached state the public dashboard renders — `agent_health_snapshot`, `agent_capabilities_snapshot`, and `agent_compliance_status` — so Addie and the dashboard never disagree, and there's no live HTTP fan-out to break. For an unknown URL the tool routes the user to `save_agent` (registers the URL so the heartbeat picks it up) or `evaluate_agent_quality` (runs the comply storyboard suite live). Tool sets, router patterns, exposed-tools, behavior rules, prompts, the auto-generated catalog, and `org-admins.mdx` were updated to point at `get_agent_status`.

Note: `check_publisher_authorization` calls `/api/validate` via the same loopback POST path and is silently CSRF-blocked too. Tracked separately — not fixed in this PR.
