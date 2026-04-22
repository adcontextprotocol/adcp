---
---

feat(addie): Google Docs reader now returns markdown (#2703).

`read_google_doc` has always existed; it just returned flat text, which meant members sharing a draft as a Google Doc lost all formatting on the way to `propose_content`. It now returns clean markdown with headings (TITLE/SUBTITLE/H1–H6), inline bold/italic/strikethrough, links, ordered and unordered lists (nested up to common depths), and GFM pipe tables preserved. Sheets still export CSV; Slides still export plain text (no markdown export available); other Drive files unchanged.

Two paths updated:
- **Drive API export** (primary for most Docs when the Drive API is reachable) now requests `text/markdown` instead of `text/plain` — Google added this export format in 2024.
- **Docs API direct read** (fallback for unverified OAuth apps where Drive API is blocked) now runs the structured Docs response through a new `extractMarkdownFromDocsResponse` converter rather than emitting flat text. Covered by 13 unit tests in `google-docs-markdown.test.ts`.

Side changes:
- `read_google_doc` added to `ALWAYS_AVAILABLE_TOOLS` so Addie can call it regardless of router intent selection — reading a shared Doc is the precondition for `propose_content`, not a separate category.
- System prompt updated: when a member shares a Docs link, Addie should call `read_google_doc` → `propose_content` in one turn. Paste-into-Slack fallback remains for access-denied.
- `propose_content` tool description reinforced: pass the `content` field from `read_google_doc` straight through.

Follow-ups on epic #2693: #2700 auto cover image, #2702 escalation linking, #2699 rich-text paste in dashboard editor.
