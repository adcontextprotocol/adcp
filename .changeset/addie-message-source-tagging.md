---
---

Add `message_source` column to `addie_thread_messages` (migration 451) and tag all write paths at write-time. Web CTA chips (welcome cards, home prompt cards, URL-param module starts) and Slack button-triggered prompts are tagged `cta_chip`; typed input is tagged `typed`. Replaces the fragile stopgap string-allowlist in `conversation-insights-builder.ts` (introduced in PR #3415) with a column-based `IS DISTINCT FROM 'cta_chip'` filter. Closes #3455.
