---
---

feat(brand-logos): Slack notification on pending uploads + SLA hint in response (closes part of #4748)

Follow-up to #4743's walk-back of community logo auto-approval. With uploads now queueing as `pending` instead of going live instantly, moderators need a signal to drain the queue, and uploaders need to know roughly when their change will appear.

**Slack notification.** `notifyPendingBrandLogo()` fires from both the HTTP route (`POST /api/brands/:domain/logos`) and Addie's `upload_brand_logo` MCP tool whenever a logo lands with `review_status='pending'`. Posts to `REGISTRY_EDITS_CHANNEL_ID` (same channel as other registry edit notifications). Includes uploader, tags, format, optional note, and a link to the brand viewer where moderators can review. Owner-attested uploads (auto-approved) do not fire — they're already trust-bound. Fire-and-forget: notification failure is logged but doesn't block the upload response.

**SLA hint.** `201` response for pending uploads now includes:
- `review_sla_hours: 48`
- `message: "Logo queued for moderator review (typically within 48h). It will appear on the brand viewer once approved."`

Same hint in Addie's tool response so chat users know what to expect.

**Tests.** Updated `brand-logos-upload-auth.test.ts` and `addie-upload-brand-logo-auth.test.ts` to assert:
- Pending uploads fire the notification with the expected payload.
- Owner-attested (auto-approved) uploads do not fire.
- Refused uploads (verified_owner_required) do not fire.

**Not in this PR** (still on #4748): moderator queue UI (list of pending across all brands), per-user pending-queue depth alerts, per-brand reserved-slot logic for verified-owner uploads. Smallest unblocker first.
