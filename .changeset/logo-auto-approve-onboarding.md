---
---

fix(admin): auto-approve member logo uploads that pass format/size/safety validation

Resolves the stalled-onboarding escalation path from issue #2568. Previously,
community uploads sat in a `pending` queue with no admin UI to process them and no
member-visible status beyond a hardcoded "pending review" message.

**`server/src/routes/brand-logos.ts`**: Community uploads that clear the existing
membership + ban + magic-bytes + SVG-sanitization + size gates are now
auto-approved (`review_status: 'approved'`). The manifest is rebuilt for all
auto-approved uploads, so logos appear immediately. The `source` field still
distinguishes `brand_owner` from `community` for audit purposes.

**`server/public/brand-viewer.html`**: Upload success message now uses
`result.review_status` from the API response — "Logo uploaded and live." when
approved, "Logo uploaded — pending review." as fallback — instead of always
showing the pending message regardless of actual status.

**`server/src/addie/mcp/brand-tools.ts`**: `upload_brand_logo` tool was a
separate code path that still hardcoded `review_status: 'pending'`, bypassing the
HTTP route's approval logic. Fixed to match: inserts as `'approved'`, rebuilds
manifest, and returns the correct status. Tool description updated accordingly.

Non-breaking: no schema changes; `review_status` was already returned in the
HTTP response. Existing `rejected`/`deleted` paths and the `review_brand_logo`
admin tool are unchanged.

Closes #2568.
