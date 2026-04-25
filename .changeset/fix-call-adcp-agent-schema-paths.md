---
---

Fix `skills/call-adcp-agent/SKILL.md` bundled-schema path references: replace hardcoded `dist/schemas/` paths (spec-repo source layout, wrong for all SDK consumers) with an ordered probe list (local SDK install → local spec-repo build → HTTP canonical URL at `https://adcontextprotocol.org/schemas/v3/bundled/`). Add underscore→hyphen translation note for tool names in filenames. Removes false claim that `npm run sync-schemas` exists across all SDKs.
