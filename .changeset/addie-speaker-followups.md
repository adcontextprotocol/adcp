---
---

Follow-ups to #3267: extend per-message speaker tracking to the surfaces
that were left out for scope, and harmonize thread-level display labels
with the new resolver.

- **`email-conversation-handler.ts`**: stamp `user_id` (sender email) and
  `user_display_name` (sanitized From-name) on inbound user messages.
  Pass `currentSpeakerName` through. Conversation history reads the
  stored display name. Forwarded chains and reply-alls now distinguish
  speakers in the prompt the same way Slack channel threads do.
- **`tavus.ts`**: stamp speaker on the user-role message and pass
  `currentSpeakerName` through `processMessageStream`.
- **`bolt-app.ts`**: switch the 5 `getOrCreateThread` call sites from
  `mc?.slack_user?.display_name` to `resolveSpeakerDisplayName(mc)` so
  the thread-level label and per-message labels for the same user
  match. Resolves the cosmetic inconsistency flagged in the original
  code review.

The synthetic `addie-admin.ts` test-router endpoint is intentionally
left as-is — it writes to a `test-user` thread for router simulation,
not a real conversation.
