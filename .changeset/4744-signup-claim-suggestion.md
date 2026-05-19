---
---

feat(brand-claim): signup-domain → claim suggestion (closes #4744)

Implements Brian's KYC framing from the 2026-05-18 Slack thread: when a user signs up with a verified email domain that matches a brand in the registry, nudge them to claim it. Three surfaces:

**1. Dashboard banner.** Soft, dismissible banner on `/dashboard` for any user whose signup domain matches a registry brand. Links to `/brand/builder?domain=…` (the existing claim flow, #4742). Dismissal records a **30-day cooldown** in a new `user_dismissed_nudges` table; the banner reappears after that or on any of the re-surface triggers from #4765.

**2. Just-in-time prompt on `/brand/view/{domain}`.** Same banner, scoped: only fires when the brand being viewed equals the user's verified email domain. Highest-intent moment — the user is literally looking at "their" brand.

**3. Slack notify to ops** on every signup whose verified email domain matches a registry brand. Fires via `notifyBrandClaimOpportunity()`. No threshold today — volume is low and we want maximum visibility into who's signing up at known brands. Throttle later if needed.

**Suppression rules** (per #4765 design discussion):
- Free email domains (gmail, etc.) — never suggest.
- Brand verified by caller's own org — already done, skip.
- Brand verified by another org — claim would collision-fail at the DNS step, skip.
- User dismissed within 30 days — suggestion still returns but `active: false`.

**Delegation is orthogonal.** Per the design discussion, we deliberately don't try to handle holding-co / agency / consultant scenarios here. Those go through #4747's delegated-grant flow (planned) or the brand-owning org adding the user to their WorkOS org. The signup-domain-claim flow stays narrow: "you control this domain, want to claim it?"

**Endpoints**
- `GET /api/me/brand-claim-suggestion` — returns `{ suggestion: { domain, brand_name, active, dismissed_at?, claim_url, view_url } | null }`. Pass `?domain=…` to scope to a specific brand (drives the JIT prompt).
- `POST /api/me/brand-claim-suggestion/dismiss` — records a 30-day cooldown for the `(user, domain)` pair.

**Storage**
- New `user_dismissed_nudges` table (migration 485) — generic, reusable for future in-app nudges. PK `(workos_user_id, nudge_key)`.

**Tests**
15 unit tests pin the suppression matrix (free email, no brand, own-org owned, other-org owned, unclaimed), the cooldown semantics (within 30d → inactive; older than 30d → active again), endpoint canonicalization, scoped JIT lookup, and the dismiss roundtrip.

**Out of scope**
- The re-surface triggers from #4765 Q8 (someone else's claim attempt, brand-viewer first visit, new auth session) — needs additional event plumbing; cooldown-based re-fire covers the baseline.
- Cross-org delegation (#4747).
