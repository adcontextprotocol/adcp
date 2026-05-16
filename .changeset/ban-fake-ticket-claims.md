---
---

Fix #3720. Addie was telling users "the team has been notified (ticket #228)" without ever calling `escalate_to_admin`. The post-message lint at `claude-client.ts` already covered fake invoice/DM/escalation-resolved claims but missed ticket-creation and "team has been notified"/"I've flagged this" patterns. Added four new patterns covering those, exported `detectHallucinatedAction` so the patterns are unit-testable, and strengthened the constraint in `addie/rules/constraints.md` to call out fake escalations and fake GitHub issue filings explicitly. `escalate_to_admin` is in the always-available tool set, so there's no excuse for claiming an escalation without making the call.
