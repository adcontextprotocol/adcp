---
---

fix(docs): correct broken relative path in v3.0.1 snapshot and acorn parse error in SKILL.md

- `dist/docs/3.0.1/contributing/storyboard-authoring.md`: `../../static/` → `../../../../static/` (snapshot is 4 levels deep, not 2)
- `skills/call-adcp-agent/SKILL.md` line 228: wrap `{account_id, brand, operator, …}` in backticks to prevent acorn treating it as a JSX expression
- `scripts/rewrite-dist-links.sh`: add sed rule so future snapshots of depth-1 docs pages automatically get the correct static-link depth
