---
---

Make member agent registration self-explanatory.

- Rename the dashboard CTA from "+ Add agent" to "+ Register agent" so the action matches the registry concept.
- Replace the seed prompt sent to Addie with a natural first-person phrasing: `Help me register my agent.` (Old prompts read either like compliance jargon or like an LLM addressing another LLM.) Centralized as a `REGISTER_AGENT_SEED_PROMPT` constant in `dashboard-agents.html`, mirrored in `org-health.ts`.
- Teach Addie to drive a structured intake when a user asks to register: agent URL → auth method (none / bearer / basic / OAuth client credentials) → matching auth fields → protocol. Includes a paste-it-all shortcut for power users, an explicit override of the "act immediately on a pasted URL" rule when intent is registration, a no-echo-secrets rule, and an error-recovery branch (`save_agent` failures: probe timeout, auth rejected, validation, permission denied). The `type` field is server-resolved and never asked.
- Interactive OAuth user authorization is described as a separate step — register with `None`, then click **Authorize** on the agent card. `save_agent` no longer advertises a fifth auth mode it can't actually persist.
- Trim the `save_agent` tool description by ~45% — push the intake script out of the tool description and into `behaviors.md` (single source of truth).
- Restructure `docs/registry/registering-an-agent.mdx` so section 1 ("Self-registration (members only)") is the single place a member learns the click path. Fixes the wrong `?org=<slug>` parenthetical (actual URL uses `?org=<id>`), aligns tier wording with the live gate (`Professional tier or higher`), and accurately describes type resolution as a capability-snapshot read, not a live probe.
- Fix broken `/login` link → use `/auth/login` (the bare `/login` route 404s; AuthKit handles both sign-in and sign-up via `/auth/login`).
