# The Changelog

A contributor briefing from Sage covering what's happening across working groups, protocol development, governance, and community contributions.

## Problem

The Prompt covers the industry narrative for everyone. Contributors need something different: what decisions were made in working groups this cycle, what shipped in the protocol, what proposals are open for comment, where help is needed. Today that information is scattered across Slack channels, GitHub, and meeting notes. Contributors either miss decisions or discover them after the fact.

## Vision

The Changelog is Sage's biweekly dispatch to everyone doing the work. Not just developers — policy writers, measurement specialists, creative standards authors, governance participants. Anyone with a contributor seat is building the future of agentic advertising, whether they're writing code or writing specs.

Sage doesn't editorialize about industry trends — she tells you what changed, what was decided, and where your input is needed.

Published as a perspective for SEO. Teal palette. Sage's voice.

## Audience

### Who receives it

Anyone with a **contributor seat** on their organization's membership. This is the distinguishing signal — contributor seats are allocated by organizations for people actively participating in the work.

Email category: `the_changelog`

### The Prompt vs. The Changelog

| | The Prompt (Addie) | The Changelog (Sage) |
|---|---|---|
| **For** | Everyone following agentic advertising | Everyone contributing to it |
| **Framing** | "Here's what's happening in the industry" | "Here's what we decided and built" |
| **WG content** | Insider intelligence ("they're debating X") | Decision log ("the group decided X") |
| **Tone** | Opinionated, narrative | Precise, actionable |
| **Default audience** | All members | Contributor seats |

## Content structure

### 1. Sage's status line

One sentence summary of the cycle. States facts, not themes.

Example: "Three WG decisions finalized, AdCP v0.14.0 shipped with breaking changes to media buy lifecycle, and the Measurement group needs reviewers for the attribution spec."

**Source:** Generated last, synthesizing all sections below.

### 2. Decisions & proposals

What working groups decided, and what's open for comment. This is the section contributors care about most — it's how they stay in the loop without attending every meeting.

Each entry includes:
- Working group name
- Decision or proposal title
- Status: `decided` | `open for comment` | `under review`
- One-line summary of what was decided or what's being proposed
- Link to the relevant document, issue, or meeting notes
- Comment deadline (for open proposals)

**Source:** WG meeting notes, Slack activity, spec PRs. The `buildWgDigestContent()` function already surfaces this — reframe from "activity" to "decisions."

### 3. What shipped

Protocol releases, SDK updates, platform changes. Each entry includes:
- Version number and release date
- One-line summary
- Link to release notes
- Breaking changes flagged with `BREAKING` and migration notes

**Source:** GitHub releases API + `addie_knowledge` changelog entries.

### 4. Deep dive

One focused writeup per edition. Not strictly technical — could be a protocol pattern, a governance process explained, a measurement methodology, or an implementation guide. 800 words max.

Examples:
- "How the media buy lifecycle state machine works" (technical)
- "The measurement attribution model: what was decided and why" (policy)
- "Signal provider onboarding: from registration to first bid" (practical)

**Source:** Curated. Admin selects topic, Sage drafts, admin reviews.

### 5. Where help is needed

3-5 items where contributor input would move things forward. Not just GitHub issues — also spec reviews needing comments, WG roles to fill, standards documents needing expert review.

Each entry includes:
- Title and link
- Working group or repo
- Type: `code` | `review` | `writing` | `expertise`
- One sentence of context

**Source:** GitHub issues (labeled `help-wanted`), WG leader requests, open spec PRs.

### 6. Contributor spotlight

Brief recognition of notable contributions merged or completed this cycle. Credit by name. One sentence on what they did and why it matters.

**Source:** Merged PRs from external contributors, WG meeting minutes, completed spec drafts.

### 7. Sage's sign-off

```
That's the cycle. If something's missing, file an issue. If something's wrong, open a PR. If you want to shape what's next, show up to a working group.

— Sage
docs.adcontextprotocol.org
```

## Sage's voice

| Dimension | Addie (The Prompt) | Sage (The Changelog) |
|-----------|-------------------|---------------------|
| Perspective | First person, opinionated | First person, precise |
| Tone | "Here's what I'm watching" | "Here's what changed" |
| Audience assumption | Practitioners, mixed technical | Contributors, mixed expertise |
| Hedging | Some ("I think this signals...") | None ("The group decided...") |
| Jargon | Explains or avoids | Uses domain terms, explains protocol-specific ones |
| Humor | Warm, occasional | Dry, rare |
| Sign-off style | Encouraging, share-oriented | Direct, contribution-oriented |

Sage never uses "exciting", "amazing", or "incredible." She respects her readers' time. She also never summarizes a decision without linking to the source — contributors should be able to verify and dig deeper.

## Data model

### ChangelogContent

```typescript
interface ChangelogContent {
  contentVersion: 1;
  statusLine: string;
  decisions: ChangelogDecision[];
  whatShipped: ChangelogRelease[];
  deepDive: ChangelogDeepDive | null;
  helpNeeded: ChangelogHelpItem[];
  contributorSpotlight: ChangelogContributor[];
  editorsNote?: string;
  emailSubject?: string;
  editHistory?: ChangelogEditEntry[];
  generatedAt: string;
}

interface ChangelogDecision {
  workingGroup: string;
  workingGroupId: string;
  title: string;
  status: 'decided' | 'open_for_comment' | 'under_review';
  summary: string;
  url: string;
  commentDeadline?: string;        // ISO date, for open proposals
}

interface ChangelogRelease {
  repo: string;
  version: string;
  releaseDate: string;
  summary: string;
  releaseUrl: string;
  breaking: boolean;
  migrationNote: string | null;
}

interface ChangelogDeepDive {
  title: string;
  slug: string;
  body: string;                    // markdown
  relatedDocs: string[];
}

interface ChangelogHelpItem {
  title: string;
  url: string;
  source: string;                  // WG name or repo
  type: 'code' | 'review' | 'writing' | 'expertise';
  context: string;
}

interface ChangelogContributor {
  name: string;
  handle?: string;                 // GitHub handle if applicable
  contribution: string;            // one sentence
  url?: string;                    // PR, doc, or meeting link
}

interface ChangelogEditEntry {
  editedBy: string;
  editedAt: string;
  description: string;
}
```

### Database

```sql
CREATE TABLE changelog_editions (
  id SERIAL PRIMARY KEY,
  edition_date DATE NOT NULL UNIQUE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent')),
  perspective_id UUID REFERENCES perspectives(id),
  review_channel_id TEXT,
  review_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  approved_by TEXT,
  approved_at TIMESTAMPTZ
);

CREATE INDEX idx_changelog_editions_status ON changelog_editions(status);
CREATE INDEX idx_changelog_editions_date ON changelog_editions(edition_date DESC);
```

```sql
INSERT INTO email_categories (name, description, default_opted_in)
VALUES ('the_changelog', 'The Changelog — Sage''s contributor briefing', false);
```

## Cover illustration

Teal palette (#0d9488 primary) with the full cast — not just technical characters. Contributors include policy people, measurement specialists, and strategists. Feature Sage prominently.

## Email template

- Header: "The Changelog" in teal (#0d9488)
- Subheader: "from Sage"
- Subject format: `The Changelog: [top decision or release]`
- Shared layout grid with The Prompt, teal accent color replaces blue

## Admin workflow

Same layout as `/admin/digest`. Admin editor at `/admin/changelog`.

## Cadence

Biweekly, aligned to WG meeting cycles. Skip if nothing substantive happened. Off-cycle manual trigger for breaking protocol changes.

## Public vs. member content

**Public:** Status line, Decisions & proposals (titles + summaries), What shipped, Cover image
**Contributor-only:** Deep dive, Help needed (with direct links), Contributor spotlight

The decisions section is public because transparency about what the org is deciding builds trust. The deep dive rewards contributors with actionable detail.

## Build stages

1. Data model + WG decision extraction + GitHub data fetching
2. Email template + admin editor (clone from The Prompt)
3. Perspective publishing + teal cover illustration
4. Contributor seat targeting + send
