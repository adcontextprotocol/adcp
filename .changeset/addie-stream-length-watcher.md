---
---

fix(addie): chunk long streamed replies into a continuation message

Slack's `chat.stopStream` rejects with `msg_too_long` once the cumulative streamed message crosses a server-side cap (undocumented, observed around 12,000 chars). PR #4820 made the resulting fallback survivable, but a long Addie reply still broke the streaming UX entirely. This adds proactive length-watching to the DM streaming loop:

1. **Decision function in `server/src/addie/slack-blocks.ts`.** `decideStreamAppend(streamedLen, delta, softCap)` returns the prefix to append to the stream, the carry remainder, and whether to finalize. Splits at paragraph → line → word boundaries, with a hard cut for whitespace-free tokens (long URLs, base64 blobs).

2. **Length-watcher in `bolt-app.ts` streaming loop.** Tracks bytes actually appended (`streamedLen`), separate from `fullText.length`. When a delta would cross `STREAM_SOFT_CAP` (default 9000, tunable via `ADDIE_STREAM_SOFT_CAP`), append the safe prefix, append a `_(continued in next message ↓)_` marker, stop the stream, and route subsequent deltas into a continuation buffer.

3. **Continuation post.** After the model finishes, the continuation buffer is posted via `say()` as a follow-up in the same thread, prefixed with `_(continued from above ↑)_`, chunked through `splitMrkdwnIntoSections`, carrying the inline images and feedback block.

4. **Failure modes.**
   - If the early `streamer.stop` fails, the post-loop fallback still has the full reply in `fullText` and ships it as a chunked `say()` (existing path).
   - If upstream Claude fails after early finalization (`stream_error` event), the recovery banner posts via `say()` since the streamed message is sealed.
   - Tool widgets after the cap simply don't render — execution still tracked.

5. **Telemetry.** Logs `streamedLen`, `softCap`, `carryLen`, `fullTextLen` on every cap hit so we can tune the default once we have a few real cases.

Tests cover the decision function: paragraph/line/word/hard-cut boundary preferences, exact-cap, delta-larger-than-cap-from-zero, streamed-len-already-at-cap, full-delta-preserved across `appendPart + carryPart`. The streaming loop itself is not unit-tested — manual smoke verification required.
