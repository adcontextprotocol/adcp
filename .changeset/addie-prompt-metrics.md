---
---

Suggested-prompts usage metrics: heuristic click tracking + admin dashboard. Adds `clicked_count` and `last_clicked_at` to `addie_prompt_telemetry` (migration 442). Detects clicks by exact-string match between incoming user messages and the rule registry's prompt strings, recorded fire-and-forget at message receipt sites (Slack assistant thread, Slack handler, web chat stream + non-stream endpoints). New admin endpoint `/api/admin/prompt-metrics` and dashboard at `/admin/prompt-metrics` showing per-rule shown/clicked/CTR/suppression with sortable columns; dormant rules (never shown) surfaced in red. Click on a rule clears `suppressed_until` so a user re-engaging gets normal evaluation again.
