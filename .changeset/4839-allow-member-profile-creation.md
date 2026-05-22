---
---

fix(member-profiles): allow member-role users to bootstrap their org's profile

Closes #4839. Member-role users who land on the member-profile setup form (often via the "register your agent" CTA on the dashboard) hit `403 — Only admins and owners can create member profiles`. Meanwhile `POST /api/me/agents` already allowed any-role member to register an agent and auto-bootstrapped the profile silently via `ensureMemberProfileExists`. Two paths, two gates, one frustrated reporter.

Closing the inconsistency: any-role member may now bootstrap the profile. New profiles still default to `is_public: false`. The `is_public: true` flip in the same call is downgraded to `false` for non-admin/owner creators with a `visibility_downgraded` warning (matching the existing tier-downgrade pattern). Publishing publicly later still goes through the dedicated `/visibility` PUT route, which retains its admin/owner gate.

Server-side fix only — no spec change.
