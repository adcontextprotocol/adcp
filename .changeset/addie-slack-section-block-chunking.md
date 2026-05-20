---
---

fix(addie): chunk long replies into multiple Slack section blocks

Slack rejects `section.text.text` over 3000 chars with `invalid_blocks`. The streaming fallback `say()` in `addie/bolt-app.ts` and the announcement review card / public payload in `announcement-handlers.ts` were stuffing entire replies (and LLM-generated announcement drafts) into a single section block, so any long output failed at the wire and the user was left with nothing.

**Three changes:**

1. **New shared module `server/src/addie/slack-blocks.ts`** with `splitMrkdwnIntoSections` (paragraph/line/word-aware chunking, ~2900-char per section, caps at 40 blocks with a truncation marker), `truncateNotificationText` (clamps the top-level `text` notification fallback so it can't trip `msg_too_long`), and `SLACK_SECTION_HARD_LIMIT` for callers that need the constant.

2. **`bolt-app.ts` DM fallback paths** (streaming + non-streaming) now chunk via the shared helpers instead of emitting one giant section.

3. **`announcement-handlers.ts`** review card and public payload chunk via the shared helpers; the LinkedIn draft surface uses a new local `buildLinkedInDraftSection` that truncates with a clear warning when the draft exceeds LinkedIn's own 3000-char post cap — multi-fence splitting would defeat the copy-paste UX and any draft that long already needs editor edits.

Tests in `server/tests/unit/addie/slack-blocks.test.ts` pin empty input, exact-boundary, single-token overflow, markdown list across a boundary, paragraph-style overflow with the truncation marker, and Block Kit shape (catches typo regressions that would only surface at Slack).

Does not address the `streamer.stop()` `msg_too_long` failure mode — that is server-enforced by Slack on cumulative streamed message length and needs a mid-stream length-watcher; tracked separately.
