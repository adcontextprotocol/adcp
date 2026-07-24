---
---

fix(server): tolerate out-of-range numeric HTML entities in `decodeHtmlEntities`

`decodeHtmlEntities` decoded numeric character references with
`String.fromCodePoint`, which throws a `RangeError` for code points outside the
valid Unicode range (`0`..`0x10FFFF`). A malformed reference such as
`&#9999999999;` or `&#xFFFFFFFF;` therefore crashed the caller.

The helper runs on untrusted external input — RSS/feed titles and summaries
(`addie/services/feed-fetcher.ts`, `routes/admin/feeds.ts`, `routes/latest.ts`)
and scraped page metadata (`routes/committees.ts`) — so a single feed item with
a bad numeric entity could throw an uncaught exception during content
processing.

Invalid or out-of-range numeric references are now left as their original
literal text instead of throwing. Valid references (including astral-plane
emoji and the maximum code point `U+10FFFF`) decode exactly as before. Adds
regression coverage in `tests/utils/html-entities.test.ts`.
