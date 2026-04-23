---
---

Workflow B Stage 1 — announcement drafter + editorial review trigger:

- New `announcement-drafter` service drafts Slack (mrkdwn) and LinkedIn (copy-paste with hashtags) welcome posts from org, profile, and brand.json inputs. Uses the shared `complete()` LLM wrapper on the primary model tier.
- New `announcement-visual` service resolves a draft visual: brand.json `logos[0].url` for companies, approved member portrait for individuals, and an `${APP_URL}/AAo-social.png` fallback. Source is tagged for observability.
- New `announcement-trigger` scheduled job runs hourly during business hours. Picks up orgs with a `profile_published` activity and a brand.json manifest, no prior `announcement_draft_posted`/`announcement_skipped` activity, and `is_public = true`. Drafts copy, resolves a visual, and posts a Block Kit review card to a new `SLACK_EDITORIAL_REVIEW_CHANNEL` with three actions (`announcement_approve_slack`, `announcement_mark_linkedin`, `announcement_skip`). Writes an `announcement_draft_posted` `org_activities` row carrying the drafted texts + visual in metadata so Stage 2 interactivity handlers can publish without re-drafting.
- Job no-ops cleanly when `SLACK_EDITORIAL_REVIEW_CHANNEL` is unset. Per-run draft cap of 5.

Follow-up to PR #2246. Stage 2 (Bolt action handlers) and Stage 3 (admin-members "Mark posted to LinkedIn") ship separately.
