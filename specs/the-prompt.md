# The Prompt

The definitive weekly newsletter for the agentic advertising revolution, written by Addie.

## Problem

The current Weekly Digest is an org newsletter — "here's what happened at AAO this week." It reads like meeting minutes, not industry intelligence. Members in multiple working groups also receive separate biweekly WG emails, creating inbox fatigue. The web view is noindex and invisible to search engines.

## Vision

The Prompt is a weekly note from Addie covering what matters in agentic advertising. AAO is the vantage point, not the subject. Addie has unique perspective because she's plugged into working groups, member conversations, and industry news — but she's reporting on the industry, not the org.

Each edition is published as a perspective article: indexed for SEO, browsable on the site, likeable, and shareable. A public summary drives discovery; the full edition rewards members.

## Content structure

### 1. Addie's opening take

One sharp paragraph. Her thesis for the week — what's converging, what shifted, what people should be paying attention to. Opinionated, specific, written in first person.

Example tone: "Three things converged this week that tell me the buy-side is finally moving. Here's what I'm watching."

Not: "This week the AAO community was busy with several activities."

**Source:** LLM-generated from all content below, after assembly. This is the last thing generated because it synthesizes everything.

### 2. What to watch

The 3-5 industry stories that matter, each with Addie's take on why. External news, not AAO navel-gazing. The framing is "why this matters to you as a practitioner" not "why this matters to our org."

**Source:** `addie_knowledge` table (quality_score >= 4), same pipeline as current news selection but with revised editorial prompt.

**Change from current:** Rename from "Industry Briefing." Increase from 3 to up to 5 articles. Revise LLM prompt to write as Addie's voice, not org perspective.

### 3. From the inside

What practitioners are actually debating. This is where working group activity, notable Slack conversations, and meeting recaps surface — framed as insider intelligence, not org updates.

"The Measurement group is wrestling with how to reconcile attention metrics across agent-initiated impressions" reads as industry intel. "The Measurement Working Group met on Tuesday" reads as a meeting recap.

**Sources (merged):**
- Working group summaries (currently in main digest)
- Notable conversations (currently in main digest)
- Meeting recaps (currently in biweekly WG digest)
- Active threads (currently in biweekly WG digest)

**Personalization:** Recipient's WG memberships are highlighted (existing blue border pattern). Content from user's groups appears first. WG-specific detail that was previously in the biweekly email is included inline for the user's groups and collapsed/linked for others.

**This replaces the biweekly WG digest email entirely.** Members get one email, not N+1.

### 4. Voices

Member perspectives and expert takes, framed as opinion and analysis. Not "our members wrote stuff" but "here's what practitioners are saying."

**Source:** `perspectives` table (content_origin != 'official', published in last 7 days), same as current member perspectives.

### 5. Quick hits

One-liners woven into the flow, not dedicated sections:
- New members: "Welcome to 4 new orgs this week, including [notable name]" in the opening or sign-off
- Social post ideas: Dropped as a section; the content lives in #social-post-ideas on Slack
- Spotlight/CTA: Woven into sign-off ("The Media Buying group meets Thursday — jump in")

### 6. Addie's sign-off

Personal, brief, with her signature. Sets up the CTA naturally.

```
That's the week. If one thing stuck, share it — this stuff moves faster when more people are paying attention.

— Addie
AgenticAdvertising.org
```

Followed by: segment-appropriate CTA (join Slack / create account / invite a colleague), feedback thumbs, unsubscribe.

## Publishing as a perspective

Each sent edition creates a perspective row:

| Field | Value |
|-------|-------|
| `slug` | `the-prompt-YYYY-MM-DD` |
| `content_type` | `'article'` |
| `content_origin` | `'official'` |
| `title` | Email subject line |
| `category` | `'The Prompt'` |
| `excerpt` | Addie's opening take (the intro paragraph) |
| `content` | Full rendered markdown of the edition |
| `author_name` | `'Addie'` |
| `author_title` | `'AI at AgenticAdvertising.org'` |
| `status` | `'published'` |
| `published_at` | Send timestamp |
| `tags` | Derived from news article tags |
| `source_type` | `'manual'` |
| `working_group_id` | Editorial WG ID |

### Public vs. member content

The perspective page at `/perspectives/the-prompt-YYYY-MM-DD` shows:

**Public (visible to all, indexed):**
- Addie's opening take
- What to watch (titles + "why it matters" takes)
- Voices (titles + excerpts with links)
- Gemini cover image
- Like button

**Member-only (behind login):**
- From the inside (WG activity, conversations, meeting recaps)
- New member names
- Slack thread links
- Full article summaries

Implementation: The `content` field stores the full edition in markdown. The perspective article page checks auth and renders either the full content or the public excerpt. The gating is UI-level, not a separate content field — keep it simple.

### Cover image

Generate a Gemini cover image per edition using the existing `illustration-generator.ts` pipeline. Input: the edition title and Addie's opening take. The image serves as:
- `featured_image_url` on the perspective card
- OG image for social sharing (`/perspectives/the-prompt-YYYY-MM-DD/card.png`)
- Hero image on the web perspective page

### SEO

- Remove `noindex` from the perspective page (it inherits the standard perspective SEO treatment)
- OG meta tags: title, description (excerpt), image (cover), type=article
- Sitemap inclusion via existing perspectives sitemap logic
- Canonical URL: `https://agenticadvertising.org/perspectives/the-prompt-YYYY-MM-DD`

### Likes

Free via existing `perspective_likes` system. No additional work.

## Email template changes

### Branding
- Header: "The Prompt" (not "AgenticAdvertising.org Weekly")
- Subheader: "from Addie" in lighter text
- Subject format: `The Prompt: [topic of the week]`

### Section headers
- "What to watch" (was "Industry Briefing")
- "From the inside" (was "Working Group Updates" + "Notable Conversations")
- "Voices" (was "From members")
- Remove: "New Members" section, "Ready to share" section, "Reports & Research" section (official perspectives fold into What to Watch or Voices as appropriate)

### Sign-off
Replace anonymous footer with Addie's signature block.

### Segment CTAs
Keep existing segment logic (website_only / slack_only / both / active) but update copy to match new voice.

## Consolidating WG digests

The biweekly WG digest (`wg-digest-builder.ts`, `wg-digest.ts` job) is replaced by the "From the inside" section of The Prompt.

### What moves into The Prompt
- Activity summaries → "From the inside" section
- Meeting recaps → "From the inside" section
- Active threads → "From the inside" section (merged with current "Notable Conversations")
- Next meetings → Woven into WG entries or spotlight CTA
- New WG members → Dropped (low signal)

### Personalization
- Each recipient's WG memberships determine which groups get expanded detail vs. one-line summaries
- User's groups: show summary + meeting recap + active threads (the full content that was in the WG email)
- Other groups: show one-line summary only + "see more on the web"
- Web perspective page: shows all WG detail for logged-in members

### Migration
1. Build "From the inside" content assembly in the main digest builder
2. Update email template with new section
3. Disable biweekly WG digest job
4. Remove WG digest email category from preferences (migrate subscribers)

## Revised LLM prompts

### News selection (What to watch)
```
You are Addie, writing The Prompt — the weekly newsletter for
practitioners navigating the agentic advertising revolution.

Select the top {N} articles and write your take on why each one
matters. Write in first person. Be direct and opinionated — your
readers are practitioners who want signal, not press releases.

Frame each take as: why should someone building or buying agentic
advertising care about this? What does it mean for their work
this quarter?

Do not promote competitor orgs as industry leaders. If covering
their news, frame it as what it means for the ecosystem.

Respond in JSON: [{"index": N, "whyItMatters": "..."}]
1-2 sentences per take.
```

### Opening take (generated last)
```
You are Addie, writing the opening paragraph of The Prompt — your
weekly note to the agentic advertising community.

You have unique perspective: you sit inside working group
conversations, read every industry article, and talk to practitioners
daily. Write a 2-3 sentence opening that captures the week's theme.

Be specific and opinionated. Name the tension, the trend, or the
surprise. Write in first person. No emojis. No "this week at AAO."

Content this week:
- {N} industry stories: {titles}
- Working groups: {summaries}
- {N} member perspectives
- {N} notable conversations
- {N} new members
```

### From the inside (WG framing)
```
You are Addie. Summarize this working group's activity as insider
intelligence — what practitioners are debating and deciding, not
what meetings happened. One paragraph, 2-3 sentences. First person
where natural. No org-speak.
```

## Database changes

### Migration: add newsletter edition tracking

```sql
-- Link digest editions to their published perspective
ALTER TABLE weekly_digests
  ADD COLUMN perspective_id UUID REFERENCES perspectives(id);

CREATE UNIQUE INDEX idx_weekly_digests_perspective
  ON weekly_digests(perspective_id) WHERE perspective_id IS NOT NULL;
```

### Migration: consolidate email categories

```sql
-- Rename digest email category
UPDATE email_categories
  SET name = 'the_prompt',
      description = 'The Prompt — Addie''s weekly newsletter'
  WHERE name = 'weekly_digest';

-- Mark WG digest category as deprecated (don't delete, preserve opt-out history)
UPDATE email_categories
  SET description = 'Deprecated — consolidated into The Prompt'
  WHERE name = 'wg_digest';
```

## Build stages

### Stage 1: Content restructure + perspective publishing
- Restructure `buildDigestContent()` with new content hierarchy
- Revise LLM prompts for Addie's voice
- Merge WG digest content sources into main builder
- Create perspective row after `markSent()`
- Generate Gemini cover image per edition
- Public/member content split on perspective page
- Update email template branding and section headers
- Add Addie's signature block
- Database migration for `perspective_id` on weekly_digests

### Stage 2: Consolidate WG digests
- Add per-recipient WG expansion logic to email rendering
- Disable biweekly WG digest job
- Migrate email category preferences
- Update Slack review message format

### Stage 3: Digest editor page
- Two-column editor (controls + live preview)
- Rich text editor's note with link support
- Drag-to-reorder articles
- Addie links to editor from Slack review and web chat

## Non-goals

- Per-user article selection (same articles, different emphasis via WG ordering)
- Hero images in email HTML (rendering problems, client blocking)
- Custom social sharing UI beyond OG tags + likes
- Real-time collaborative editing
- Separate public newsletter product (public perspective summary handles this)

## Success metrics

- Open rate (target: >40%, up from current baseline)
- Click-through rate on "What to watch" links
- Perspective page views from organic search
- Like count per edition
- Reduction in email volume per member (should drop by N biweekly WG emails)
- Qualitative: members reference The Prompt in conversations
