---
---

Fix Addie misidentifying the speaker in multi-human Slack channel threads.

Previously, when an admin replied mid-thread to a non-member's question,
Addie addressed the response to the original speaker and skipped tools the
admin had access to (e.g. `create_github_issue` via WorkOS Pipes). The DB
had no per-message speaker, and the prompt builder collapsed every
non-Addie turn into anonymous `role='user'` text — so the LLM lost track
of speaker switches mid-thread.

Changes:

- **Migration `435_thread_message_speaker.sql`**: nullable `user_id` and
  `user_display_name` columns on `addie_thread_messages`. Old rows degrade
  gracefully via the `'User'` sentinel.
- **`prompts.ts`**: new `BuildMessageTurnsOptions.currentSpeakerName`. When
  the thread has multiple distinct named humans, every user-role turn
  (history + current) is prefixed `[Name] ...`. Single-speaker threads keep
  prior behavior. New `sanitizeSpeakerName` helper strips brackets,
  newlines, and control chars and caps length so user-controlled display
  names cannot break out of the prompt envelope.
- **`bolt-app.ts`**: speaker stamped on all 6 user-role write sites; 3
  `conversationHistory` builders surface the stored display name; 6
  `processOptions` carry `currentSpeakerName`. Mention handler appends
  "the message you are responding to is from **{name}**" to the
  system-prompt thread context block.
- **`addie-chat.ts`**: speaker stamped on both web user-message write sites
  and `currentSpeakerName` plumbed through. `user_name` from the request
  body is now ignored on anonymous requests so unauthenticated callers
  cannot assert identity into the LLM context.
- **`claude-client.ts`**: `currentSpeakerName` plumbed through both
  `processMessage` and `processMessageStream`.

Repro and regression coverage at `server/scripts/repro-addie-thread-speaker.ts`
and `server/tests/unit/build-message-turns-speakers.test.ts`. Email,
admin-chat, and Tavus single-speaker write sites are not updated — they
do not trigger the bug class. The reaction handler intentionally does not
prefix synthetic `[User reacted ...]` turns.
