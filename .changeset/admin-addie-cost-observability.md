---
---

Add admin observability for the per-user Addie Anthropic cost cap (#2945,
follow-up to #2790 / #2946 / #2950).

New admin page at `/admin/addie-costs` and three read-only endpoints:

- `GET /api/admin/addie-costs/summary` — workspace 24h/7d totals and a
  per-namespace breakdown (email / slack / mcp / tavus / anon / workos /
  unknown) so operators can see which caller category dominates spend.
- `GET /api/admin/addie-costs/leaderboard?window=24h|7d&limit=N` — top
  scope keys by spend with inferred tier, % of cap, event count, and
  model mix. Bare WorkOS scope keys join back to `users` +
  `organization_memberships` + `organizations` so paying members show
  `member_paid` tier; email hash / mcp sub / tavus IP scopes stay
  opaque by design.
- `GET /api/admin/addie-costs/scope/:scopeKey/events` — drill-in with
  the 200 most-recent events for one scope (timestamp, model, token
  volume, cost).

Tier inference on the leaderboard is defensive: `member_paid` is only
claimed when a bare WorkOS id joins to an active subscription;
everywhere else the displayed cap falls back to the namespace-level
inference (anonymous for email/mcp/tavus/anon, member_free for
slack/workos) so an email-hash scope can't be mis-displayed as a
paying-member ceiling.
