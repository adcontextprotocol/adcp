# Unified Content Management System

## What We're Building

A content management system that separates authorship (who gets credit) from ownership (who controls), supports co-authoring, and enables content proposals with review workflows.

---

## Core Concepts

### Authorship vs Ownership vs Proposer

| Role | What it means | Example |
|------|--------------|---------|
| **Authors** | Who gets display credit | "By Alice Chen and Bob Smith" |
| **Owner** | Who can publish/edit/delete | Committee leads control committee content |
| **Proposer** | Who originally submitted | Tracked for pending items; may differ from authors |

### Ownership Rules

```
Content Type          → Owner
─────────────────────────────────────────────────────
Personal perspective  → The individual author
Committee content     → Committee leads (via working_group_leaders)
Site-wide content     → Site admins
```

### Content Status Flow

```
[draft] ──user creates──→ [pending_review] ──owner approves──→ [published]
                                    │
                                    └──owner rejects──→ [rejected]
```

- Members with ownership rights can skip `pending_review` and publish directly
- Content always starts as `draft` when created, moves to `pending_review` on submission

---

## Data Model Changes

### 1. New Table: `content_authors`

Replaces single `author_user_id` with support for multiple co-authors.

```sql
CREATE TABLE content_authors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perspective_id UUID NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,  -- WorkOS user ID
  display_name VARCHAR(255) NOT NULL,
  display_title VARCHAR(255),
  display_order INTEGER DEFAULT 0,  -- For author ordering
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(perspective_id, user_id)
);

CREATE INDEX idx_content_authors_perspective ON content_authors(perspective_id);
CREATE INDEX idx_content_authors_user ON content_authors(user_id);
```

### 2. Modify `perspectives` Table

```sql
-- Add proposer tracking and new status
ALTER TABLE perspectives
  ADD COLUMN proposer_user_id VARCHAR(255),
  ADD COLUMN proposed_at TIMESTAMPTZ,
  ADD COLUMN reviewed_by_user_id VARCHAR(255),
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN rejection_reason TEXT;

-- Update status constraint to include new states
ALTER TABLE perspectives
  DROP CONSTRAINT IF EXISTS perspectives_status_check,
  ADD CONSTRAINT perspectives_status_check
    CHECK (status IN ('draft', 'pending_review', 'published', 'archived', 'rejected'));

-- Backfill: existing author_user_id becomes both proposer and first author
-- (handled in migration)
```

### 3. Keep Existing Columns (Backward Compatible)

- `author_user_id` - deprecated but kept for backward compatibility; will be the "primary" author
- `author_name` / `author_title` - kept for display fallback; computed from first author going forward

---

## Permission Model

### Who Can Do What

```typescript
interface ContentPermissions {
  // Anyone can propose content to any collection
  canPropose: () => boolean; // Always true for authenticated users

  // Ownership determines control
  canPublish: (content: Perspective, user: User) => boolean;
  canEdit: (content: Perspective, user: User) => boolean;
  canDelete: (content: Perspective, user: User) => boolean;
}

function isOwner(content: Perspective, userId: string): boolean {
  // Personal content: user is proposer/author
  if (!content.working_group_id) {
    return content.proposer_user_id === userId ||
           content.authors?.some(a => a.user_id === userId);
  }

  // Committee content: user is committee lead
  return isCommitteeLead(content.working_group_id, userId);
}

function canPublishDirectly(content: Perspective, userId: string): boolean {
  // Site admins can always publish
  if (isAdmin(userId)) return true;

  // Committee leads can publish to their committees
  if (content.working_group_id) {
    return isCommitteeLead(content.working_group_id, userId);
  }

  // Personal content: only if no committee (goes to /perspectives page)
  // These require admin approval since they're site-wide
  return false;
}
```

### Permission Matrix

| Action | Personal Content | Committee Content | Site-wide |
|--------|-----------------|-------------------|-----------|
| Create draft | Author | Any member | Admin |
| Submit for review | Author | Any member | Admin |
| Publish directly | Never (needs admin) | Committee lead | Admin |
| Edit published | Admin | Committee lead | Admin |
| Delete | Admin | Committee lead | Admin |
| View pending | Proposer + Admin | Proposer + Lead | Admin |

---

## API Changes

### New Endpoints

```
POST   /api/content/propose
       Submit content to any collection (creates in pending_review)

GET    /api/content/pending
       List pending content user can review (as owner/lead/admin)

POST   /api/content/:id/approve
       Approve pending content (owner/lead/admin only)

POST   /api/content/:id/reject
       Reject pending content with reason (owner/lead/admin only)

GET    /api/me/content
       "My Content" view - content where user is author, proposer, or owner
```

### Propose Content

```typescript
// POST /api/content/propose
interface ProposeContentRequest {
  title: string;
  content?: string;  // Markdown for articles
  content_type: 'article' | 'link';
  external_url?: string;
  external_site_name?: string;
  excerpt?: string;
  category?: string;

  // Where it should appear
  collection: {
    type: 'personal' | 'committee';
    committee_slug?: string;  // Required if type === 'committee'
  };

  // Authors (defaults to current user)
  authors?: Array<{
    user_id: string;
    display_name: string;
    display_title?: string;
  }>;
}

interface ProposeContentResponse {
  id: string;
  status: 'draft' | 'pending_review' | 'published';
  // If user is owner, status will be 'published' (direct publish)
  // Otherwise, status will be 'pending_review'
  message: string;
}
```

### Get Pending Content

```typescript
// GET /api/content/pending
interface GetPendingResponse {
  items: Array<{
    id: string;
    title: string;
    excerpt?: string;
    proposer: {
      id: string;
      name: string;
    };
    proposed_at: string;
    collection: {
      type: 'personal' | 'committee';
      committee_name?: string;
      committee_slug?: string;
    };
    authors: Array<{
      user_id: string;
      display_name: string;
    }>;
  }>;
  summary: {
    total: number;
    by_collection: Record<string, number>;
  };
}
```

### My Content View

```typescript
// GET /api/me/content
interface MyContentResponse {
  items: Array<{
    id: string;
    title: string;
    status: string;
    collection: {
      type: 'personal' | 'committee';
      committee_name?: string;
    };
    // User's relationship to this content
    relationships: Array<'author' | 'proposer' | 'owner'>;
    published_at?: string;
    created_at: string;
  }>;
}
```

---

## Addie Tool Changes

### New Tools

```typescript
// For committee leads and admins
{
  name: 'list_pending_content',
  description: 'List content pending review that you can approve or reject.',
  input_schema: {
    type: 'object',
    properties: {
      committee_slug: {
        type: 'string',
        description: 'Filter to specific committee (optional)'
      }
    }
  }
}

{
  name: 'approve_content',
  description: 'Approve pending content for publication.',
  input_schema: {
    type: 'object',
    properties: {
      content_id: { type: 'string' },
      publish_immediately: { type: 'boolean', default: true }
    },
    required: ['content_id']
  }
}

{
  name: 'reject_content',
  description: 'Reject pending content with feedback.',
  input_schema: {
    type: 'object',
    properties: {
      content_id: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['content_id', 'reason']
  }
}
```

### Updated Tools

```typescript
// Update create_perspective to support proposals
{
  name: 'create_perspective',
  description: 'Create a perspective article or link. If targeting a committee you lead, publishes directly. Otherwise, submits for review.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
      content_type: { enum: ['article', 'link'] },
      // New: where to publish
      committee_slug: {
        type: 'string',
        description: 'Committee to publish to. Omit for personal perspective.'
      },
      // New: co-authors
      co_author_emails: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses of co-authors to add'
      }
    },
    required: ['title']
  }
}
```

### Proactive Notifications

Addie surfaces pending content to relevant users:

```typescript
// In Addie's context building
interface PendingNotification {
  type: 'pending_content';
  count: number;
  summary: string;  // "3 articles pending in Media Buying Protocol"
  action: string;   // "Use list_pending_content to review"
}

// Triggers:
// 1. When committee lead opens Addie: check for pending in their committees
// 2. When admin opens Addie: check for pending site-wide content
// 3. Daily digest option (future)
```

Example Addie prompts:

```
"You have 3 pending posts in Media Buying Protocol committee awaiting review."

"2 perspective submissions need your approval before they can be published."

"Alice Chen submitted an article 'The Future of Agentic Ads' to your committee yesterday."
```

---

## UI Requirements

### "My Content" Dashboard Section

Location: `/dashboard` or `/me/content`

```
┌─────────────────────────────────────────────────────────────┐
│ My Content                                                   │
├─────────────────────────────────────────────────────────────┤
│ [Draft] My thoughts on AI advertising            ✏️ 🗑️       │
│         Personal · You are the author                        │
│                                                              │
│ [Pending] Q4 Media Buying Trends                  👁️         │
│         Media Buying Protocol · You proposed this            │
│                                                              │
│ [Published] Welcome to NYC Chapter!              ✏️           │
│         NYC Chapter · You are a lead                         │
└─────────────────────────────────────────────────────────────┘
```

Badges:
- `author` - "You are an author"
- `proposer` - "You proposed this"
- `owner` - "You are a lead" / "You can manage"

### Pending Review Queue (for leads/admins)

Location: Committee manage page or admin dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ Pending Review (3)                                           │
├─────────────────────────────────────────────────────────────┤
│ Q4 Media Buying Trends                                       │
│ By: Alice Chen · Proposed: 2 days ago                        │
│ [Preview] [Approve] [Reject]                                 │
│                                                              │
│ New Member Welcome Guide                                     │
│ By: Bob Smith · Proposed: 5 days ago                         │
│ [Preview] [Approve] [Reject]                                 │
└─────────────────────────────────────────────────────────────┘
```

### Content Creation Flow

When member creates content:

1. **Select collection**: "Where should this appear?"
   - My personal perspectives
   - [List of committees they're members of]

2. **Add co-authors** (optional): Search by name/email

3. **Submit**:
   - If they're an owner (committee lead): "Publish now" or "Save as draft"
   - If they're not an owner: "Submit for review" (goes to pending_review)

---

## Migration Plan

### Phase 1: Database Changes

1. Create `content_authors` table
2. Add new columns to `perspectives`
3. Backfill: copy `author_user_id` to `proposer_user_id` and create `content_authors` records

### Phase 2: API Updates

1. Add new endpoints (`/api/content/*`)
2. Update existing perspective endpoints to use new permission model
3. Ensure backward compatibility with existing clients

### Phase 3: Addie Tools

1. Add `list_pending_content`, `approve_content`, `reject_content`
2. Update `create_perspective` with committee targeting
3. Add proactive pending notifications

### Phase 4: UI

1. Add "My Content" section to dashboard
2. Add pending review queue to committee manage pages
3. Update content creation flow

---

## Success Criteria

- [ ] Multiple authors can be credited on a single piece of content
- [ ] Committee leads control committee content (not individual authors)
- [ ] Non-leads can propose content that goes to pending review
- [ ] Addie proactively notifies leads/admins of pending items
- [ ] "My Content" view shows all content where user has a relationship
- [ ] Existing content continues to work (backward compatible)

---

## Terminology

- Use **"committee"** in user-facing text (covers working groups, councils, chapters)
- Keep `working_group_id` as column name (no DB rename needed)
- API uses `committee_slug` not `working_group_slug` for new endpoints
