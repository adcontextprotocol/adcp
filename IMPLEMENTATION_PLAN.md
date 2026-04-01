# The Prompt — Implementation Plan

## Stage 1: Database Migration + Content Types + Builder Rewrite
**Goal**: New content shape, merged WG content, revised LLM prompts. Existing send/review workflow still works.
**Status**: In Progress

### Tasks
- [ ] Migration 355: add `perspective_id` to `weekly_digests`
- [ ] Rewrite `DigestContent` interface in `digest-db.ts` (new fields, keep old optional for backward compat)
- [ ] Rewrite `buildDigestContent()` in `digest-builder.ts` with new hierarchy
- [ ] Merge WG content sources (reuse `wg-digest-builder.ts` functions)
- [ ] New LLM prompts for news selection, opening take, insider framing
- [ ] Update `generateDigestSubject()` for "The Prompt: ..." format
- [ ] Update `hasMinimumContent()` for new shape
- [ ] Update `digest-editor.ts` for new content shape
- [ ] Update deduplication query for `whatToWatch` field name

## Stage 2: Email + Slack Template Rewrite
**Goal**: Recipients get "The Prompt" with new branding, sections, Addie's signature, per-recipient WG expansion.
**Status**: Not Started

### Tasks
- [ ] Rewrite `renderDigestEmail()` HTML template
- [ ] Rewrite `renderDigestText()` plain text
- [ ] Rewrite `renderDigestSlack()` Block Kit
- [ ] Update `renderDigestReview()` for new sections
- [ ] Update `renderDigestWebPage()` — remove noindex
- [ ] Remove founding deadline functions (expired)
- [ ] Per-recipient WG expansion in "From the inside"
- [ ] Addie's signature block
- [ ] Update segment CTAs with new voice

## Stage 3: Perspective Publishing + Cover Image
**Goal**: Each sent edition creates a perspective for SEO, likes, browsing.
**Status**: Not Started

### Tasks
- [ ] Create `digest-publisher.ts` service
- [ ] `publishDigestAsPerspective()` — create perspective row after send
- [ ] `buildPublicMarkdown()` / `buildFullMarkdown()` for content split
- [ ] Generate Gemini cover image per edition
- [ ] Content gating on perspective page (public vs. member)
- [ ] Hook into `sendDigest()` to publish after markSent

## Stage 4: WG Digest Consolidation
**Goal**: Disable separate WG emails, migrate preferences.
**Status**: Not Started

### Tasks
- [ ] Migration 356: deprecate WG digest email category
- [ ] Disable WG digest job (early return)
- [ ] Update bolt-app.ts handlers for new content shape
- [ ] Migrate email preferences

## Stage 5: Digest Editor Page
**Goal**: Two-column admin page for editing with live preview.
**Status**: Not Started
