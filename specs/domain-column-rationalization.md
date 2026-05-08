# Domain Column Rationalization

**Status:** **Decided 2026-05-08 — Option B, in-flight**
**Issue:** [#4159](https://github.com/adcontextprotocol/adcp/issues/4159)
**Driver:** Media.net escalation [#321](https://github.com/adcontextprotocol/adcp/issues/4159) (May 2026). Stage 1 (auto-populate, [#4157](https://github.com/adcontextprotocol/adcp/pull/4157)) and Stage 2 (member self-service, [#4179](https://github.com/adcontextprotocol/adcp/pull/4179)) shipped. This is Stage 3.

## Problem

Four columns express overlapping facets of "domain" with separate write paths:

| # | Field | Purpose | Truth source |
|---|---|---|---|
| 1 | `organization_domains` rows | Set of domains an org owns | WorkOS, per-domain verification |
| 2 | `organization_domains.is_primary` | Drives **org-membership inference** ("auto-add @media.net users to Media.net") | Admin/user picks; webhook auto-promotes first verified |
| 3 | `organizations.email_domain` | Denormalized cache of #2 | Should equal the row where is_primary=true |
| 4 | `member_profiles.primary_brand_domain` | The **brand-identity primary** ("Media.net's brand.json") | Brand-claim flow + WorkOS auto-populate (#4157) + member self-service (#4179) |
| 5 | `brands.domain` + `workos_organization_id` | Public brand catalog entry | Mirrored from #1 + #4 |

Three concepts hide here: (a) the *set* of owned domains, (b) the *membership-inference primary*, (c) the *brand-identity primary*. The third drifts because writes are uncoordinated — Media.net was the canonical example.

## Survey of current state (run 2026-05-08 against prod)

```
Total member_profiles:                                   155
  primary_brand_domain == organization_domains.is_primary: 53 (34%)
  primary_brand_domain IS NULL:                            64 (41%)
  Divergent (set, but != membership-primary):             38 (25%)
```

Of the 38 divergent cases, breakdown:

| Category | Count | Disposition under Option B |
|---|---|---|
| `www.foo.com` vs `foo.com` (canonicalization bug) | ~10 | Auto-resolve during migration via `canonicalizeBrandDomain` |
| Personal-tier placeholder (`<name>.agenticadvertising.org`) | ~7 | Drop or insert as a `source='manual'` row |
| Personal-tier real brand domain, no WorkOS-verified row | ~7 | Insert `organization_domains` row with `source='manual', verified=true, is_primary=true` during migration |
| International TLDs (DanAds: .com vs .se; iPROM: .eu vs .si) | ~2 | **Real divergence.** Either accept under hierarchy model or pick one |
| DBA / sub-brand (Transfon→biddingstack, Mission→winstarinteractive) | ~2 | **Real divergence.** Hierarchy model: parent=corporate, child=brand |
| Junk (linkedin.com, hubspotusercontent CDN URL, unknown domain) | ~3 | Bug; ignore |
| Pending investigation | ~7 | Audit before migration |

**Verdict:** ~85% of divergence is bugs or trivially resolvable. ~5 orgs have real DBA/holding-co divergence — each can be handled by AAO's existing `brand-hierarchy` plumbing (parent + child orgs, `house_domain` join).

## Options

### A — Single canonical writer, both columns kept

Service `setPrimaryDomain(orgId, domain, intent: 'membership' | 'brand' | 'both')` that all writers funnel through. Already partly built in PR #4179's PUT (it dual-writes).

- ✅ Minimal disruption — schema unchanged
- ✅ Preserves the *theoretical* membership-vs-brand distinction
- ❌ Two columns still exist; future contributors will write directly to either
- ❌ Drift surface stays open, just covered by discipline. Same fragility class that produced the bugs in the first place

### B — Collapse into one primary (recommended)

Drop `member_profiles.primary_brand_domain`. Use `organization_domains.is_primary` as the single primary for both purposes. The 5% case (membership-primary ≠ brand-primary) gets handled at the *org* layer via the hierarchy model.

- ✅ No drift surface possible. Single mental model.
- ✅ Forces correct reads (single resolver / JOIN).
- ❌ Real migration: ~5 holding-co orgs need to be moved to parent/child structure first.
- ❌ ~24 source files reference `primary_brand_domain` directly; all must be rewritten to read from `organization_domains` or via a resolver.

### C — Audit consumer-by-consumer, schema unchanged

Survey reads, hide each column behind a single resolver function (`getBrandDomain(orgId)`, `getEmailDomain(orgId)`).

- ✅ Lowest risk
- ❌ Doesn't fix the drift surface. Likely a step toward A or B regardless

## Recommendation: B

The survey shows the membership-vs-brand distinction is mostly *unintentional* (bugs) or trivially resolvable. The remaining ~5 orgs that genuinely want different domains can model it cleanly via parent/child orgs — AAO already has the plumbing (`brands.house_domain`, `brand_domain_aliases`, parent_org_id resolution in `accounts.ts`). Pushing them onto that path is also better operationally — separate billing, separate seats, separate brand.json.

Option A leaves us patching the same fragility class forever. Each new write path is another opportunity to introduce drift. We've already had 3 incidents in 6 months (Media.net, Triton, the cohort sweep) tracing back to this.

## Migration plan

**Stage 0 — preconditions (1 week)**

1. Resolve the ~10 `www.foo.com` vs `foo.com` cases by canonicalizing existing `member_profiles.primary_brand_domain` values in place. Idempotent script.
2. Audit the ~5 real DBA/hierarchy cases. For each, decide: (a) accept the brand domain as the org's `is_primary` (the membership-inference loses the corporate domain — usually fine because the corp domain isn't where employees sign up via SSO anyway), or (b) split into parent/child orgs.
3. Insert missing `organization_domains` rows for personal-tier members whose `primary_brand_domain` points at a domain not in the table. `source='manual', verified=true` — they got there via the brand-claim flow which is its own proof, not WorkOS DNS.

**Stage 1 — dual-read (1 release)**

1. Introduce `getBrandPrimaryDomain(orgId)` resolver that reads from `organization_domains.is_primary` first, falls back to `member_profiles.primary_brand_domain` for safety.
2. Migrate every read site to the resolver. ~24 files, mostly mechanical.
3. Existing writers continue to write both fields.

**Stage 2 — drop the column (next release)**

1. Drop `member_profiles.primary_brand_domain`.
2. Resolver collapses to a direct query.
3. Update API types (`types.ts`, OpenAPI) — the field disappears from the wire format. Callers that relied on it must either read from the org-domains response or use the resolver.

**Stage 3 — single canonical writer (concurrent with Stage 2)**

1. `setPrimaryDomain(orgId, domain)` — the only legal way to flip primary. Writes `organization_domains.is_primary` + denormalizes to `organizations.email_domain`. Calls `markBrandDomainVerified` for the brands registry mirror.
2. Deprecate direct UPDATE of those columns; lint rule (custom semgrep) to flag direct writes.
3. Remove the dual-write logic from PR #4179's PUT — it goes through the canonical writer.

## Consumer rewrite list

24 source files reference `primary_brand_domain`. Rough categories:

| Category | Count | Action |
|---|---|---|
| Schema / type definitions (`types.ts`, OpenAPI, `member-db.ts`) | 4 | Remove field; update API contract |
| Writers (`brand-identity.ts`, `me-organization-domains.ts`, `workos-webhooks.ts`, member-profiles brand-claim) | 4 | Replace with `setPrimaryDomain` |
| Readers (services, routes, jobs) | 14 | Replace with `getBrandPrimaryDomain(orgId)` resolver |
| Backfill scripts (`backfill-primary-brand-domain.ts`, `backfill-member-announcements.ts`) | 2 | Delete or rewrite to read from the resolver |

Plus 2 frontend files (`member-profile.html`, `dashboard-agents.html`) — these read from API responses; updates are downstream of the type change.

## Risks

- **Public-agent gate change**: today the publish path reads `member_profiles.primary_brand_domain`. Switching to `organization_domains.is_primary` changes semantics for orgs where the two genuinely differ today. The migration's Stage 0 audit must catch every case, or we'll silently de-publish someone's agent.
- **`brands` registry pointer**: `brands.domain` is the public registry key. If we change which domain is "primary" for an org during migration, the brand registry entry's owning org might temporarily point to a stale domain. Coordinated re-mirror via `markBrandDomainVerified` covers it.
- **Brand-claim verify flow**: today it sets `member_profiles.primary_brand_domain`. Under Option B it would update `organization_domains` instead — possibly inserting a new row if the domain isn't already there (claim flow is for domains the user owns but hasn't WorkOS-linked).

## Out of scope

- **The `brands` registry consolidation**. It's a separate concern (public catalog, mirrored from internal state). Same drift class but different solution; address after the internal state is rationalized.
- **Multi-tenant sub-brand support**. The hierarchy model already exists; expanding it (e.g., letting one org have multiple non-corporate brand identities) is its own product question.

## Auto-link safety check (2026-05-08)

Before committing to Option B, verified that auto-membership-inference doesn't depend on `is_primary`:

`autoLinkByVerifiedDomain` (`server/src/db/membership-db.ts`) → `findPayingOrgForDomain` (`server/src/db/org-filters.ts:442-454`) joins on:

```sql
JOIN organization_domains od ON LOWER(od.domain) = LOWER(dc.domain)
WHERE od.verified = true              -- ANY verified row
  AND o.subscription_status = 'active'
```

It walks every verified row, not just the primary. So switching DanAds primary from `.se` to `.com` doesn't break `@danads.se` auto-link as long as `.se` stays verified (which it does — we just demote `is_primary`). Same for the prospect path (`findClaimableProspectOrg`, line 561-570).

**Implication:** migration is safe to flip primaries provided we **never delete the previously-primary row**, only demote `is_primary` to false.

## Per-case dispositions

Of the 38 divergent cases, 6 are non-trivial. None require the parent/child hierarchy model:

| Org | Old primary | New primary | Action | Notes |
|---|---|---|---|---|
| **DanAds** | danads.se | danads.com | Demote `.se` to non-primary verified | Real DBA case (Sweden corp / .com brand). Brand domain wins as primary |
| **iPROM** | iprom.si | iprom.eu | Demote `.si` | Same shape (Slovenia corp / .eu brand) |
| **Transfon** | transfon.com | transfon.com (no change) | Reset `primary_brand_domain` from `biddingstack.com` to `transfon.com`. BiddingStack stays as a separate `brands` row pointing at this org_id | Single org, two product brands. Already supported by the `brands` table |
| **Mission Media / Winstar** | wims.com | winstarinteractive.com (insert) | Insert `winstarinteractive.com` as `source='manual', verified=true, is_primary=true`; demote `wims.com` to non-primary | DBA. Brand wins. Needs a new org_domains row |
| **Triton Digital** | agilecompanion.com | tritondigital.com | Verify `tritondigital.com` (admin), set as primary, demote `agilecompanion.com`, remove the `www.tritondigital.com` row (canonicalization dup) | Pre-existing data corruption (see `scripts/incidents/2026-04-triton-unwind.ts`) |
| **Mangrove Digital** | mangrovedigital.com.au | mangrovedigital.com.au (no change) | Reset `primary_brand_domain` from `linkedin.com` to `mangrovedigital.com.au` | Bug — someone set LinkedIn as their brand. LinkedIn is owned by Microsoft's org_id |

## Out of scope

- **The `brands` registry consolidation**. It's a separate concern (public catalog, mirrored from internal state). Same drift class but different solution; address after the internal state is rationalized.
- **Multi-tenant sub-brand support**. The hierarchy model already exists; expanding it (e.g., letting one org have multiple non-corporate brand identities) is its own product question.

## Decision

**Option B, committed 2026-05-08.** Tracking issue [#4159](https://github.com/adcontextprotocol/adcp/issues/4159).

Sequencing:
- **Stage 0** — preconditions. Per-case data fixes for the 6 above; canonicalization for the ~10 `www.` cases; insert missing org_domains rows for personal-tier members. Open as a series of small data-fix PRs gated on this spec merging.
- **Stage 1** — `getBrandPrimaryDomain(orgId)` resolver + migrate ~14 read sites. Writers continue dual-writing.
- **Stage 2** — drop `member_profiles.primary_brand_domain` column. Update API types.
- **Stage 3** — `setPrimaryDomain(orgId, domain)` canonical writer + lint rule against direct writes.
