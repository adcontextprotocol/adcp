---
---

Fix new-member LinkedIn announcement copy: remove membership-tier language, set opening-sentence pattern, and lock in standard hashtags. Closes #3504 (items 1 and 3; item 2 pending template assets).

- `server/src/services/announcement-drafter.ts`: update `SYSTEM_PROMPT` to (a) never refer to membership tier in copy, (b) prescribe a direct name-first opening sentence, (c) mandate `#AgenticAdvertising #AgenticAI #AdCP` as the always-present hashtag set (+ up to 2 member-specific additions), and (d) fix three "AAO" → "AgenticAdvertising.org" naming violations in the prompt text.
