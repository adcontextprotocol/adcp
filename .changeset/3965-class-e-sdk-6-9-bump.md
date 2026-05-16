---
---

fix(training-agent): bump @adcp/sdk to 6.9.0, close #3965 Class E

The 6.9.0 release lands adcp-client#1477 (issue #1472), which I filed against the original 6.7.0 bump after diagnosing why `media_buy_seller/create_media_buy_async` started failing on `force_arm_submitted`: the SDK dispatcher had `forceCreateMediaBuyArm` and `forceTaskCompletion` cases but `ComplyControllerConfig.force` exposed no public seam to wire them, so adopters on the structured config always hit `UNKNOWN_SCENARIO`. 6.9.0 adds the typed slots (plus `DirectiveAdapter<P>` for the directive return shape), so wiring is now a one-line-per-scenario change in `tenants/comply.ts`:

```ts
force: {
  media_buy_status: cast(forceAdapter('force_media_buy_status')),
  create_media_buy_arm: cast(forceAdapter('force_create_media_buy_arm')),
  task_completion: cast(forceAdapter('force_task_completion')),
},
```

The v5 handlers (`handleForceCreateMediaBuyArm`, `handleForceTaskCompletion`) already returned the spec-correct `ForcedDirectiveSuccess` / completion shapes; only the structured-config bridge was missing.

6.9.0 also added a strict `account.mode` gate on `comply_test_controller` (`'sandbox'` or `'mock'` required; `'live'` denies with FORBIDDEN). Every tenant's `accounts.resolve` now stamps `mode: 'sandbox'` on both arms (anonymous public-sandbox + brand-resolved). The training agent is sandbox-only by deployment so this is the correct steady-state.

Floors ratchet to capture the new clean baseline:

| Tenant            | Old floor (6.7) | New floor (6.9) | Delta |
|-------------------|-----------------|-----------------|-------|
| /sales            | 62 / 212        | 63 / 217        | +1 / +5 |
| /governance       | 63 / 66         | 64 / 70         | +1 / +4 |
| /creative         | 64 / 79         | 65 / 83         | +1 / +4 |
| /creative-builder | 58 / 61         | 59 / 65         | +1 / +4 |
| /signals          | 65 / 23         | 65 / 23         | flat |
| /brand            | 65 / 14         | 65 / 14         | flat |

Files: `package.json`, `package-lock.json`, `server/src/training-agent/tenants/comply.ts`, six `v6-*-platform.ts` files (mode stamp), `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.

Class E closes; remaining #3965 residue is Class A (adcp-client#1455 — context echo SDK gap, not yet released) and Class C (signed_requests /mcp-strict, predates the 6.7 bump).
