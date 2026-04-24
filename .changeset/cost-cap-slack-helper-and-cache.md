---
---

Cost-cap polish bundle — closes deferred items from the #2945 / #2969
reviews.

**`buildSlackCostScope(memberContext, slackUserId)` helper.** The
8 Slack-originated call sites (6 in `bolt-app.ts`, 2 in `handler.ts`)
each had a 2-line prelude constructing the scope key and probing tier:

```ts
const costScopeUserId = memberContext?.workos_user?.workos_user_id ?? `slack:${userId}`;
const costScopeTier = await resolveUserTierFromDb(costScopeUserId);
costScope: { userId: costScopeUserId, tier: costScopeTier },
```

Collapsed to one line at each site:

```ts
costScope: await buildSlackCostScope(memberContext, userId),
```

Keeps the `slack:` fallback shape in one place so a future namespace
rename only touches the helper.

**60s memo cache on `resolveUserTierFromDb`.** Subscription status
changes on the order of days (Stripe webhooks → organizations
update), so a per-process 60s stale window cuts the DB-probe hot path
to ~1 probe per user per minute rather than 1 per Addie turn. Error
paths are NOT cached — a transient DB failure shouldn't lock a paying
member out of `member_paid` for a full TTL. Tests pin:
- Burst calls hit DB once, return cached tier thereafter.
- Error paths are not cached; next call retries.
- Cache is per-user, not global.

No behavior change for end users; pure dev-debt cleanup + perf.
