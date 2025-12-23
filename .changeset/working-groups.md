---
"adcontextprotocol": minor
---

Add Working Groups feature for AAO member collaboration.

**New Features:**
- Working Groups database schema with support for public/private groups
- Individual users (not organizations) can join working groups
- Group leadership roles: Chair and Vice-Chair
- Public groups allow self-join; private groups are invite-only
- Working group leader CMS for managing posts (chair/vice-chair access)
- Slack notifications when working group posts are published

**Admin Capabilities:**
- Create, edit, and delete working groups
- Assign leadership (chair/vice-chair) from member search
- Manage group memberships
- Export all memberships as CSV
- View all users and their working group participation

**Public Pages:**
- Working groups directory page
- Individual working group detail pages with:
  - Group description (markdown supported)
  - Leadership display
  - Member list
  - Posts/updates
  - Join/leave functionality
  - Slack channel link

**Working Group Leader Features:**
- Full CMS interface for managing group posts at `/working-groups/:slug/manage`
- Create articles or link posts
- Draft/publish/archive workflow
- Markdown editor with live preview
- URL metadata fetching for link posts

**Technical Changes:**
- New `working_groups` and `working_group_memberships` tables
- `WorkingGroupDatabase` class for database operations
- `createRequireWorkingGroupLeader` middleware for leader-only routes
- Slack notification for published working group posts
- Server-side slug validation for working groups
