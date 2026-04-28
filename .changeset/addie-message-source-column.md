---
---

Add `message_source` column to `addie_thread_messages` to distinguish
CTA chip clicks from typed messages at write-time. Migration 451 adds
the column (`NOT NULL DEFAULT 'unknown'`) with a CHECK constraint on
values `typed | cta_chip | voice | paste | unknown`. All `addMessage`
call sites in `bolt-app.ts` and `addie-chat.ts` are updated to tag the
source using the existing `matchRuleIdFromMessage` heuristic. Removes
the hardcoded NOT IN stopgap from `conversation-insights-builder.ts`
(introduced in #3415) in favour of `AND first_msg_source != 'cta_chip'`.
Resolves #3408 / #3455.
