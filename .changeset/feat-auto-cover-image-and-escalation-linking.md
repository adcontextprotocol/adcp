---
---

feat(editorial): auto cover image on pending_review (#2700) + escalation linking with auto-close (#2702).

Bundles two features from epic #2693. Both target Mary Mason's original scenario end-to-end: her ask ("can we please just auto-generate a cover image so this does not get held here?") now happens automatically, and her open escalations (#271/#277/#278) could have auto-closed when her post got approved.

**#2700 — Auto cover image.** When a perspective enters `pending_review` via `proposeContentForUser`, a non-blocking Gemini illustration generates and auto-approves in the background. Mirrors the `digest-publisher.ts` pattern: errors are logged and the submission still succeeds. Skipped when the submitter supplied their own `featured_image_url`, when the content is a link (external og:image handles it), or when the title is empty. Reviewer sees the cover in the dashboard by the time they pick up the item.

**#2702 — Escalation linking.** New migration adds `perspective_id` (UUID FK) and `perspective_slug` (TEXT) columns to `addie_escalations`. The `escalate_to_admin` Addie tool now accepts optional `perspective_id` / `perspective_slug` fields so Addie can tag escalations that are about a specific draft. When `approveContentForUser` runs, any open escalations linked to that perspective auto-resolve with a system note — the queue cleans itself up instead of accumulating stale escalations about work that's already done.

System prompt updated so Addie knows to:
- Not stall submission waiting on cover-image generation (it happens in the background).
- Pass `perspective_id` on escalations that reference a specific draft.

Remaining epic #2693 issues: #2699 (rich-text paste), plus expert-review follow-ups #2754 (structured `read_google_doc` return), #2755 (rate limit web Addie), #2734 (title length validation), #2719 (my-content.html Submit for Review option), #2733 (propose_content rate limit), #2735 (channel privacy TOCTOU), #2736 (interactive Slack DMs), #2753 (Drive vs Docs API divergence), #2752 (dead-code caps), #2713 (PUT content status transitions), #2712 (second review bypass in /working-groups/:slug/posts).
