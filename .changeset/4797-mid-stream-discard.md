---
"adcontextprotocol": patch
---

Stop persisting partial assistant turns when an Anthropic stream errors mid-reply. `processMessageStream` now yields a `stream_error` event after deltas have already shipped but before the underlying error throws (`server/src/addie/claude-client.ts`); Slack (`bolt-app.ts`), web (`addie-chat.ts`), and voice (`tavus.ts`) consumers handle it by rendering a recovery banner / SSE event and skipping persistence of the partial turn. The user's last message stays the most recent turn, so a retry or rephrase replays cleanly without a truncated assistant message biasing the resample — fixing the "goldfish" / dropped-context symptom observed during the 2026-05-19 Anthropic incidents. First step of #4797; banner + retry-after + model fallback follow.
