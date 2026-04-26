---
---

feat(editorial): content editor polish — rich-text paste, Submit-for-Review, title length validation.

Three epic #2693 cleanup items bundled:

**#2699 — Rich-text paste.** The "Write Content" editor in both `admin-content.html` and `my-content.html` now converts pasted HTML to markdown via turndown (loaded via CDN). Paste from Google Docs, Notion, or Word preserves headings, bold/italic, lists, links, and tables — no more "paste kills the formatting" loop that blocked Mary from submitting the 3.0 launch blog. Plain-text paste falls through to the browser default with no regression for members who already have markdown in their clipboard. DOMPurify sanitizes the HTML before it hits turndown.

**#2719 — my-content.html adds "Submit for Review".** Member-facing form previously only offered Draft / Publish Now, so members hitting "Publish Now" got silently demoted by the server-side review gate. Now the status dropdown has three options with `Submit for Review` as the explicit default, matching the admin-content.html form. The status hint text explains what happens.

**#2734 — Title length validation returns 400.** `proposeContentForUser` now validates `title ≤ 500`, `subtitle ≤ 1000`, `author_title ≤ 255`, `external_site_name ≤ 255` before the INSERT, so an oversized field returns a friendly 400 with a field-specific message instead of the Postgres "value too long" → HTTP 500 we were hitting. Dashboard forms also got `maxlength="500"` on the title inputs so the browser prevents entry past the limit.

Three integration tests added to `content-my-content.test.ts` covering the validation branches.

Remaining epic #2693 work: expert-review follow-ups #2712/#2713/#2733/#2735/#2736/#2752/#2753/#2754/#2755/#2756.
