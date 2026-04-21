/**
 * Assertion: `governance.denial_blocks_mutation`.
 *
 * Once a storyboard step returns a denial signal for a plan, no subsequent
 * step in the same run may acquire or mutate a resource for that plan. Catches
 * the failure mode where a seller surfaces the denial response but still
 * creates the media buy, activates the signal, syncs the property list, etc.
 * anyway — a class of bug that per-step validations can't catch because each
 * step looks locally correct.
 *
 * Scope: plan-scoped via `plan_id`. Denial on plan X blocks subsequent
 * mutations on plan X; unrelated plans in the same run proceed normally.
 * When a denial signal has no resolvable plan linkage (e.g. a
 * `POLICY_VIOLATION` on a generic seller call with no plan context), the
 * assertion falls back to run-scoped blocking for that signal only.
 *
 * Denial is sticky within a run: a subsequent successful `check_governance`
 * on the same plan does NOT clear denial state. Requiring the buyer to
 * acquire a fresh `governance_context` token is the correct semantics; this
 * assertion encodes "within-run" monotonicity.
 *
 * See adcontextprotocol/adcp#2639 for the invariants framework and the
 * protocol-expert review that grounded this semantics.
 */

import {
  registerAssertion,
  type AssertionContext,
  type AssertionSpec,
  type AssertionResult,
  type StoryboardStepResult,
} from '@adcp/client/testing';

export const ASSERTION_ID = 'governance.denial_blocks_mutation';

/**
 * Error codes that signal a seller-side refusal of a request. Grounded in
 * `static/schemas/source/enums/error-code.json`. Deliberately excludes
 * `GOVERNANCE_UNAVAILABLE` (transient / no decision rendered) and
 * `ACCOUNT_SUSPENDED` (account state, not action-specific denial).
 */
const DENIAL_ERROR_CODES = new Set([
  'GOVERNANCE_DENIED',
  'CAMPAIGN_SUSPENDED',
  'PERMISSION_DENIED',
  'POLICY_VIOLATION',
  'TERMS_REJECTED',
  'COMPLIANCE_UNSATISFIED',
]);

/**
 * Write-class tasks whose successful response carries a single server-minted
 * resource id at the top level. Read tasks (`get_*`, `list_*`, `check_governance`)
 * can echo ids back without having created anything; they are deliberately
 * excluded so the assertion doesn't false-positive on lookups after a denial.
 *
 * `sync_*` tasks (`sync_creatives`, `sync_plans`, `sync_audiences`,
 * `sync_catalogs`) are also excluded here — their responses are batch
 * envelopes (`creatives: [{ action: 'created', creative_id: ... }, ...]`),
 * not top-level ids, and detecting per-item acquisitions needs schema-
 * specific traversal. Tracked as a follow-up; until then, a seller that
 * mutates via `sync_*` after a denial slips past this assertion.
 */
const WRITE_TASKS = new Set([
  'create_media_buy',
  'update_media_buy',
  'activate_signal',
  'create_property_list',
  'update_property_list',
  'delete_property_list',
  'create_collection_list',
  'update_collection_list',
  'delete_collection_list',
  'acquire_rights',
]);

/**
 * Response fields that carry a server-minted resource id. Presence on a
 * write-task response = the seller accepted the mutation.
 */
const RESOURCE_ID_FIELDS = [
  'media_buy_id',
  'plan_id',
  'creative_id',
  'audience_id',
  'catalog_id',
  'activation_id',
  'property_list_id',
  'collection_list_id',
  'acquisition_id',
  'operation_id', // async task-handle ack; seller accepted the write
];

/**
 * Media-buy statuses that count as "resource acquired". Anything else
 * (`rejected`, `canceled`) on the same step means the seller refused
 * after all — no mutation survived. Matches
 * `static/schemas/source/enums/media-buy-status.json`.
 */
const ACQUIRED_MEDIA_BUY_STATUSES = new Set([
  'pending_creatives',
  'pending_start',
  'active',
  'paused',
  'completed',
]);

interface Anchor {
  stepId: string;
  signal: string;
}

interface State {
  /** Map from plan_id → first denial anchor for that plan. */
  deniedPlans: Map<string, Anchor>;
  /** Run-wide denial (signal had no plan linkage); blocks every subsequent write. */
  runDenial?: Anchor;
}

function getBody(stepResult: StoryboardStepResult): unknown {
  if (stepResult.response !== undefined && stepResult.response !== null) return stepResult.response;
  return undefined;
}

function extractErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (typeof record.error_code === 'string') return record.error_code;
  const err = record.error;
  if (err && typeof err === 'object') {
    const errRec = err as Record<string, unknown>;
    if (typeof errRec.code === 'string') return errRec.code;
  }
  return undefined;
}

/**
 * Pull a `plan_id` attributable to this step. Check the response body first
 * (denial envelopes per the governance schemas carry `plan_id` on the
 * response; `check_governance` 200-denied always does), then the outgoing
 * request payload recorded by the runner. Never falls back to accumulated
 * `context` — stale `plan_id` values from much-earlier steps would bind
 * denials to the wrong plan. When neither source carries one, return
 * undefined and let the caller decide (denial falls back to run-wide scope;
 * mutation only checks run-wide denial state).
 */
function extractPlanId(stepResult: StoryboardStepResult): string | undefined {
  const body = getBody(stepResult);
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec.plan_id === 'string' && rec.plan_id) return rec.plan_id;
  }
  const req = (stepResult as { request?: { payload?: unknown } }).request;
  if (req && typeof req.payload === 'object' && req.payload !== null) {
    const payload = req.payload as Record<string, unknown>;
    if (typeof payload.plan_id === 'string' && payload.plan_id) return payload.plan_id;
  }
  return undefined;
}

function detectDenial(stepResult: StoryboardStepResult): string | undefined {
  const body = getBody(stepResult);
  const code = extractErrorCode(body);
  if (code && DENIAL_ERROR_CODES.has(code)) return code;
  // `check_governance` decides-no with a 200 response and `status: "denied"`
  // (see static/schemas/source/governance/check-governance-response.json).
  if (stepResult.task === 'check_governance' && body && typeof body === 'object') {
    const status = (body as Record<string, unknown>).status;
    if (status === 'denied') return 'CHECK_GOVERNANCE_DENIED';
  }
  return undefined;
}

/**
 * Did this step acquire a resource? Only write-class tasks qualify, and the
 * step must be success (`passed`, not `expect_error`) with a minted id in
 * the response body. The `passed && !expect_error` guard already excludes
 * error envelopes — no need to re-scan for a `code` field, which could be a
 * legitimate non-error field on future write responses. Media-buy responses
 * additionally gate on status so `rejected`/`canceled` don't false-positive
 * as "acquired".
 */
function detectResourceAcquired(stepResult: StoryboardStepResult): { field: string; id: string } | undefined {
  if (stepResult.expect_error) return undefined;
  if (!stepResult.passed) return undefined;
  if (!WRITE_TASKS.has(stepResult.task)) return undefined;

  const body = getBody(stepResult);
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;

  if (stepResult.task === 'create_media_buy' || stepResult.task === 'update_media_buy') {
    const status = record.status;
    if (typeof status === 'string' && !ACQUIRED_MEDIA_BUY_STATUSES.has(status)) return undefined;
  }

  for (const field of RESOURCE_ID_FIELDS) {
    const val = record[field];
    if (typeof val === 'string' && val.length > 0) return { field, id: val };
  }
  return undefined;
}

function onStart(ctx: AssertionContext): void {
  ctx.state.deniedPlans = new Map<string, Anchor>();
  // Reset run-wide denial too — state objects survive across runs in some
  // test harnesses, and a stale anchor here would block a fresh run's
  // unrelated mutations.
  ctx.state.runDenial = undefined;
}

function onStep(
  ctx: AssertionContext,
  stepResult: StoryboardStepResult
): Omit<AssertionResult, 'assertion_id' | 'scope'>[] {
  const state = ctx.state as unknown as State;
  const planId = extractPlanId(stepResult);
  const results: Omit<AssertionResult, 'assertion_id' | 'scope'>[] = [];

  // A denial signal and an acquired-resource id on the same step is
  // ill-formed by the spec (a denied response shouldn't carry a minted
  // resource id), and different parts of the response could plausibly hold
  // each. Precedence: record the denial, skip the acquire check for this
  // step. Downstream steps are still gated by the recorded anchor, so the
  // net effect of a weird "denied + acquired on same step" is a clean
  // denial record plus the assertion firing on the NEXT mutation, which is
  // the actionable information.
  const denialSignal = detectDenial(stepResult);
  if (denialSignal) {
    const anchor: Anchor = { stepId: stepResult.step_id, signal: denialSignal };
    if (planId) {
      if (!state.deniedPlans.has(planId)) state.deniedPlans.set(planId, anchor);
    } else if (!state.runDenial) {
      state.runDenial = anchor;
    }
    return results;
  }

  const acquired = detectResourceAcquired(stepResult);
  if (!acquired) return results;

  const anchor = (planId && state.deniedPlans.get(planId)) ?? state.runDenial;
  if (!anchor) return results;

  results.push({
    passed: false,
    description: 'Mutation acquired a resource after a governance denial',
    error:
      `step "${anchor.stepId}" returned ${anchor.signal}` +
      (planId ? ` for plan_id=${planId}` : ' (run-wide)') +
      `; subsequent step "${stepResult.step_id}" (task=${stepResult.task}) ` +
      `acquired ${acquired.field}=${acquired.id}` +
      (planId ? ' for the same plan' : ''),
  });
  return results;
}

export const spec: AssertionSpec = {
  id: ASSERTION_ID,
  description:
    'After a governance denial, no subsequent step in the run may acquire a resource for the same plan',
  onStart,
  onStep,
};

registerAssertion(spec);
