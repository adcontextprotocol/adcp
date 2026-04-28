# Integrity invariants

Each invariant in this directory is a self-contained assertion about state across **WorkOS**, **Stripe**, and **AAO Postgres**. The runner executes them on demand (Phase 1) or on a schedule (Phase 2, future), collects violations, and surfaces them in the admin UI.

## When to add a new invariant

If you find yourself thinking "I wish we'd noticed sooner that X had drifted from Y," that's an invariant. Concretely:

- A bug surfaced because two stores said different things → file an invariant that asserts they agree.
- A migration / refactor made a previously-implicit assumption explicit → encode it.
- A webhook handler is the only thing keeping a row up to date → audit periodically that it actually is.

Phase 1 deliberately ships only five invariants. Five is enough to demonstrate the framework and catch the highest-cost failure modes (Triton-shape bugs). Phase 2+ adds breadth.

## How to add an invariant

1. Drop a file in `invariants/` exporting a single `Invariant` value:

   ```ts
   import type { Invariant, InvariantContext, InvariantResult } from '../types.js';

   export const myInvariant: Invariant = {
     name: 'descriptive-kebab-case-name',
     description: 'One-sentence "why does this matter."',
     severity: 'critical' | 'warning' | 'info',
     async check(ctx: InvariantContext): Promise<InvariantResult> {
       // Walk your working set, emit Violation[] on mismatch.
       return { checked: N, violations: [...] };
     },
   };
   ```

2. Register it in `invariants/index.ts`:

   ```ts
   import { myInvariant } from './my-invariant.js';
   export const ALL_INVARIANTS: readonly Invariant[] = [
     // ...
     myInvariant,
   ];
   ```

3. Add a unit test under `server/tests/unit/integrity-invariants/`. Mock the DB and external APIs through the `InvariantContext` shape; the test surface should be tiny.

## Severity guide

- **`critical`** — the violation indicates active financial / data-integrity damage. Triton's two-active-subs case is critical. Operators should be paged.
- **`warning`** — drift that's recoverable but should be investigated. Tier mismatch (DB vs Stripe) is warning, because it can be a transient webhook race.
- **`info`** — the entity is in a permitted-but-unusual state worth noting. Use sparingly; too much info-level noise drowns the criticals.

## Running

On demand:

- `GET /api/admin/integrity/invariants` — list all registered invariants
- `GET /api/admin/integrity/check` — run all, return report
- `GET /api/admin/integrity/check/:name` — run one
- Both accept `?sample_size=N` and `?since=ISO8601` query params

The runner executes invariants sequentially. One throwing doesn't cancel the others — its failure becomes a meta-violation in the report.

## Performance

- Phase 1 invariants iterate AAO orgs as the primary key set (~hundreds-to-thousands at current scale) and call Stripe/WorkOS for each. A full pass takes ~30s.
- The membership-resolve invariant samples (default 200 random rows). Set `?sample_size=N` to widen.
- A scheduled runner will be added in Phase 2 alongside a persisted `integrity_runs` table for time-series tracking.

## What this framework deliberately doesn't do

- **Auto-remediation.** Phase 1 detects; humans decide. Auto-fix is Phase 3+.
- **Real-time monitoring.** Webhooks remain the primary sync mechanism. Invariants catch what webhooks miss.
- **Stripe-customer enumeration.** We walk AAO orgs and check Stripe for each. Catching orphans on the *Stripe* side (customers with no AAO row) requires the inverse walk and is Phase 3+.
- **Replace `POST /api/admin/accounts/:orgId/sync`.** That endpoint is for explicit single-org reconciliation. Invariants tell you which orgs to sync.

## Reference

- Original proposal: `.context/proposals/integrity-invariants.md` (in workspace, not committed)
- Issue: #3181 (broader systematic-audit ask)
- Triton/Encypher incident: PRs #3142, #3171, #3183 (Apr 2026)
