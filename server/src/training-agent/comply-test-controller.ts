/**
 * Training-agent wrapper around the SDK's comply_test_controller.
 *
 * The SDK owns the scenario dispatcher, response envelope, and per-scenario
 * enum validation (`@adcp/client` exports `handleTestControllerRequest`,
 * `CONTROLLER_SCENARIOS`, `TOOL_INPUT_SHAPE`, `enforceMapCap`). This file
 * adds the two things the SDK intentionally leaves to the seller: a sandbox
 * gate on the top-level `account.sandbox` flag, and a per-request
 * `TestControllerStore` bound to our JSONB-persisted `SessionState`.
 */

import {
  CONTROLLER_SCENARIOS,
  TestControllerError,
  createSeedFixtureCache,
  enforceMapCap,
  handleTestControllerRequest,
} from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';
import type { BrandReference } from '@adcp/client';
import type {
  TrainingContext,
  ToolArgs,
  SessionState,
  MediaBuyState,
  CreativeState,
  GovernancePlanState,
  AccountRef,
  BrandRef,
  ComplyDeliveryAccumulator,
  ComplyBudgetSimulation,
} from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import { getAgentUrl } from './config.js';

// ── State machine transition tables ───────────────────────────────

const CREATIVE_TRANSITIONS: Record<string, string[]> = {
  processing: ['pending_review', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['pending_review', 'rejected', 'archived'],
  rejected: ['processing'],
  archived: ['approved'],
};

const ACCOUNT_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ['active', 'rejected'],
  active: ['payment_required', 'suspended', 'closed'],
  payment_required: ['active'],
  suspended: ['active', 'payment_required', 'closed'],
  rejected: [],
  closed: [],
};

const ACCOUNT_TERMINAL = new Set(['rejected', 'closed']);

const MEDIA_BUY_TRANSITIONS: Record<string, string[]> = {
  pending_creatives: ['pending_start', 'rejected', 'canceled'],
  pending_start: ['active', 'rejected', 'canceled'],
  active: ['paused', 'completed', 'canceled'],
  paused: ['active', 'completed', 'canceled'],
  completed: [],
  rejected: [],
  canceled: [],
};

const MEDIA_BUY_TERMINAL = new Set(['completed', 'rejected', 'canceled']);

const SI_SESSION_TRANSITIONS: Record<string, string[]> = {
  active: ['pending_handoff', 'complete', 'terminated'],
  pending_handoff: ['complete', 'terminated'],
  complete: [],
  terminated: [],
};

const SI_SESSION_TERMINAL = new Set(['complete', 'terminated']);

// ── Session accessors (used by other handlers) ──────────────────────

/** Get delivery simulation data for a media buy (used by get_media_buy_delivery). */
export function getDeliverySimulation(session: SessionState, mediaBuyId: string): ComplyDeliveryAccumulator | undefined {
  return session.complyExtensions.deliverySimulations.get(mediaBuyId);
}

/** Get budget simulation data for an entity (used by get_account_financials). */
export function getBudgetSimulation(session: SessionState, entityId: string): ComplyBudgetSimulation | undefined {
  return session.complyExtensions.budgetSimulations.get(entityId);
}

/** Get account status set by comply test controller. */
export function getAccountStatus(session: SessionState, accountId: string): string | undefined {
  return session.complyExtensions.accountStatuses.get(accountId);
}

// ── Helpers ───────────────────────────────────────────────────────

function findMediaBuy(session: SessionState, mediaBuyId: string): MediaBuyState | undefined {
  return session.mediaBuys.get(mediaBuyId);
}

function validateTransition(
  transitions: Record<string, string[]>,
  terminalSet: Set<string>,
  currentStatus: string,
  targetStatus: string,
  entityType: string,
): void {
  const validTargets = transitions[currentStatus];
  if (!validTargets || !validTargets.includes(targetStatus)) {
    const detail = terminalSet.has(currentStatus)
      ? `Cannot transition ${entityType} from ${currentStatus} to ${targetStatus} — ${currentStatus} is terminal`
      : `Cannot transition ${entityType} from ${currentStatus} to ${targetStatus}`;
    throw new TestControllerError('INVALID_TRANSITION', detail, currentStatus);
  }
}

// ── TestControllerStore factory ───────────────────────────────────

function createStore(session: SessionState): TestControllerStore {
  return {
    async forceCreativeStatus(creativeId, status, rejectionReason) {
      const creative = session.creatives.get(creativeId);
      if (!creative) {
        throw new TestControllerError('NOT_FOUND', `Creative ${creativeId} not found`, null);
      }

      const prev = creative.status;
      if (prev === status) {
        return { success: true, previous_state: prev, current_state: status, message: `Creative ${creativeId} is already ${status}` };
      }

      validateTransition(CREATIVE_TRANSITIONS, new Set(), prev, status, 'creative');

      if (status === 'rejected' && !rejectionReason) {
        throw new TestControllerError('INVALID_PARAMS', 'rejection_reason is required when status = rejected', prev);
      }

      creative.status = status;
      return { success: true, previous_state: prev, current_state: status, message: `Creative ${creativeId} transitioned from ${prev} to ${status}` };
    },

    async forceAccountStatus(accountId, status) {
      const ext = session.complyExtensions;
      const prev = ext.accountStatuses.get(accountId) ?? 'active';

      if (prev === status) {
        return { success: true, previous_state: prev, current_state: status, message: `Account ${accountId} is already ${status}` };
      }

      validateTransition(ACCOUNT_TRANSITIONS, ACCOUNT_TERMINAL, prev, status, 'account');
      enforceMapCap(ext.accountStatuses, accountId, 'account statuses');
      ext.accountStatuses.set(accountId, status);
      return { success: true, previous_state: prev, current_state: status, message: `Account ${accountId} transitioned from ${prev} to ${status}` };
    },

    async forceMediaBuyStatus(mediaBuyId, status, rejectionReason) {
      const mb = findMediaBuy(session, mediaBuyId);
      if (!mb) {
        throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`, null);
      }

      const prev = mb.status;
      if (prev === status) {
        return { success: true, previous_state: prev, current_state: status, message: `Media buy ${mediaBuyId} is already ${status}` };
      }

      validateTransition(MEDIA_BUY_TRANSITIONS, MEDIA_BUY_TERMINAL, prev, status, 'media buy');

      if (status === 'rejected' && !rejectionReason) {
        throw new TestControllerError('INVALID_PARAMS', 'rejection_reason is required when status = rejected', prev);
      }

      const now = new Date().toISOString();
      mb.status = status;
      mb.updatedAt = now;

      if (status === 'canceled') {
        mb.canceledAt = now;
        mb.canceledBy = 'seller';
        mb.cancellationReason = rejectionReason || 'Forced by comply test controller';
      }

      mb.history.push({
        revision: mb.revision,
        timestamp: now,
        actor: 'seller',
        action: `status_forced_to_${status}`,
        summary: `Comply test controller forced status to ${status}`,
      });

      return { success: true, previous_state: prev, current_state: status, message: `Media buy ${mediaBuyId} transitioned from ${prev} to ${status}` };
    },

    async forceSessionStatus(sessionId, status, terminationReason) {
      const ext = session.complyExtensions;
      const siSession = ext.siSessions.get(sessionId);

      if (!siSession) {
        // Unknown sessions are implicitly active
        if (status === 'terminated' && !terminationReason) {
          throw new TestControllerError('INVALID_PARAMS', 'termination_reason is required when status = terminated');
        }
        enforceMapCap(ext.siSessions, sessionId, 'si sessions');
        ext.siSessions.set(sessionId, { status, terminationReason });
        return { success: true, previous_state: 'active', current_state: status, message: `Session ${sessionId} transitioned from active to ${status}` };
      }

      const prev = siSession.status;
      if (prev === status) {
        return { success: true, previous_state: prev, current_state: status, message: `Session ${sessionId} is already ${status}` };
      }

      validateTransition(SI_SESSION_TRANSITIONS, SI_SESSION_TERMINAL, prev, status, 'session');

      if (status === 'terminated' && !terminationReason) {
        throw new TestControllerError('INVALID_PARAMS', 'termination_reason is required when status = terminated');
      }

      siSession.status = status;
      if (terminationReason) siSession.terminationReason = terminationReason;
      return { success: true, previous_state: prev, current_state: status, message: `Session ${sessionId} transitioned from ${prev} to ${status}` };
    },

    async simulateDelivery(mediaBuyId, params) {
      const mb = findMediaBuy(session, mediaBuyId);
      if (!mb) {
        throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`, null);
      }

      if (MEDIA_BUY_TERMINAL.has(mb.status)) {
        throw new TestControllerError('INVALID_STATE', `Cannot simulate delivery for media buy in ${mb.status} state`, mb.status);
      }

      const impressions = params.impressions || 0;
      const clicks = params.clicks || 0;
      const conversions = params.conversions || 0;
      const reportedSpend = params.reported_spend;

      const ext = session.complyExtensions;
      let cumulative = ext.deliverySimulations.get(mediaBuyId);
      if (!cumulative) {
        enforceMapCap(ext.deliverySimulations, mediaBuyId, 'delivery simulations');
        cumulative = {
          impressions: 0,
          clicks: 0,
          reportedSpend: { amount: 0, currency: reportedSpend?.currency || mb.currency },
          conversions: 0,
        };
        ext.deliverySimulations.set(mediaBuyId, cumulative);
      }

      cumulative.impressions += impressions;
      cumulative.clicks += clicks;
      cumulative.conversions += conversions;
      if (reportedSpend) {
        cumulative.reportedSpend.amount += reportedSpend.amount;
        cumulative.reportedSpend.currency = reportedSpend.currency;
      }

      const simulated: Record<string, unknown> = {};
      if (impressions) simulated.impressions = impressions;
      if (clicks) simulated.clicks = clicks;
      if (reportedSpend) simulated.reported_spend = reportedSpend;
      if (conversions) simulated.conversions = conversions;

      return {
        success: true,
        simulated,
        cumulative: {
          impressions: cumulative.impressions,
          clicks: cumulative.clicks,
          reported_spend: cumulative.reportedSpend,
          conversions: cumulative.conversions,
        },
        message: `Delivery simulated for ${mediaBuyId}: ${impressions} impressions, ${clicks} clicks${reportedSpend ? `, $${reportedSpend.amount.toFixed(2)} spend` : ''}`,
      };
    },

    async simulateBudgetSpend(params) {
      const { account_id: accountId, media_buy_id: mediaBuyId, spend_percentage: spendPercentage } = params;

      if (spendPercentage < 0 || spendPercentage > 100) {
        throw new TestControllerError('INVALID_PARAMS', 'spend_percentage must be between 0 and 100');
      }

      let budgetAmount = 0;
      let currency = 'USD';
      const entityId = mediaBuyId || accountId!;

      if (mediaBuyId) {
        const mb = findMediaBuy(session, mediaBuyId);
        if (!mb) {
          throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`, null);
        }
        budgetAmount = mb.packages.reduce((sum, pkg) => sum + pkg.budget, 0);
        currency = mb.currency;
      } else {
        for (const [, mb] of session.mediaBuys) {
          if (mb.accountRef?.account_id === accountId) {
            budgetAmount += mb.packages.reduce((sum, pkg) => sum + pkg.budget, 0);
            currency = mb.currency;
          }
        }
      }

      if (budgetAmount <= 0) {
        throw new TestControllerError('INVALID_PARAMS', `No budget configured for ${mediaBuyId ? 'media buy' : 'account'} ${entityId}`);
      }

      const computedSpend = Math.round(budgetAmount * (spendPercentage / 100) * 100) / 100;

      const ext = session.complyExtensions;
      enforceMapCap(ext.budgetSimulations, entityId, 'budget simulations');
      ext.budgetSimulations.set(entityId, {
        spendPercentage,
        computedSpend: { amount: computedSpend, currency },
        budget: { amount: budgetAmount, currency },
      });

      return {
        success: true,
        simulated: {
          spend_percentage: spendPercentage,
          computed_spend: { amount: computedSpend, currency },
          budget: { amount: budgetAmount, currency },
        },
        message: `Budget for ${entityId} set to ${spendPercentage}% consumed ($${computedSpend.toFixed(2)} of $${budgetAmount.toFixed(2)})`,
      };
    },

    // ── Seed scenarios (spec: storyboard fixtures block) ──────────────
    // Fixtures are permissive objects (spec: additionalProperties: true).
    // Each seed method merges the fixture on top of sensible defaults and
    // stores in the session. Idempotency (same ID + equivalent fixture
    // returns success, same ID + different fixture returns INVALID_STATE)
    // is enforced by the SDK's seed cache wired in handleComplyTestController.

    async seedProduct(productId, fixture) {
      const ext = session.complyExtensions;
      enforceMapCap(ext.seededProducts, productId, 'seeded products');
      ext.seededProducts.set(productId, { product_id: productId, ...(fixture ?? {}) });
    },

    async seedPricingOption(productId, pricingOptionId, fixture) {
      const ext = session.complyExtensions;
      const key = `${productId}:${pricingOptionId}`;
      enforceMapCap(ext.seededPricingOptions, key, 'seeded pricing options');
      ext.seededPricingOptions.set(key, {
        product_id: productId,
        pricing_option_id: pricingOptionId,
        ...(fixture ?? {}),
      });
    },

    async seedCreative(creativeId, fixture) {
      const fx = (fixture ?? {}) as Record<string, unknown>;
      enforceMapCap(session.creatives, creativeId, 'creatives');
      const existing = session.creatives.get(creativeId);
      const now = new Date().toISOString();
      const formatId = (fx.format_id as CreativeState['formatId']) ?? existing?.formatId ?? { id: 'display_300x250' };
      session.creatives.set(creativeId, {
        creativeId,
        formatId,
        name: (fx.name as string | undefined) ?? existing?.name,
        status: (fx.status as string | undefined) ?? existing?.status ?? 'approved',
        syncedAt: existing?.syncedAt ?? now,
        manifest: (fx.manifest as CreativeState['manifest']) ?? existing?.manifest,
        pricingOptionId: (fx.pricing_option_id as string | undefined) ?? existing?.pricingOptionId,
      });
    },

    async seedPlan(planId, fixture) {
      const fx = (fixture ?? {}) as Record<string, unknown>;
      enforceMapCap(session.governancePlans, planId, 'governance plans');
      const existing = session.governancePlans.get(planId);
      const fxBudget = (fx.budget as Record<string, unknown> | undefined) ?? {};
      const fxFlight = (fx.flight as { start?: string; end?: string } | undefined) ?? {};
      const now = new Date().toISOString();
      const defaultFlightEnd = new Date(Date.now() + 90 * 86_400_000).toISOString();
      session.governancePlans.set(planId, {
        planId,
        version: (fx.version as number | undefined) ?? existing?.version ?? 1,
        status: (fx.status as GovernancePlanState['status']) ?? existing?.status ?? 'active',
        brand: (fx.brand as BrandReference) ?? existing?.brand ?? { domain: 'acmeoutdoor.example' },
        objectives: (fx.objectives as string | undefined) ?? existing?.objectives ?? 'seeded plan',
        budget: {
          total: (fxBudget.total as number | undefined) ?? existing?.budget.total ?? 0,
          currency: (fxBudget.currency as string | undefined) ?? existing?.budget.currency ?? 'USD',
          reallocationThreshold:
            (fxBudget.reallocation_threshold as number | undefined)
            ?? existing?.budget.reallocationThreshold
            ?? 0,
          reallocationUnlimited:
            (fxBudget.reallocation_unlimited as boolean | undefined)
            ?? existing?.budget.reallocationUnlimited
            ?? false,
          perSellerMaxPct:
            (fxBudget.per_seller_max_pct as number | undefined) ?? existing?.budget.perSellerMaxPct,
          allocations:
            (fxBudget.allocations as GovernancePlanState['budget']['allocations'])
            ?? existing?.budget.allocations,
        },
        humanReviewRequired:
          (fx.human_review_required as boolean | undefined) ?? existing?.humanReviewRequired ?? false,
        humanReviewAutoFlippedBy: existing?.humanReviewAutoFlippedBy ?? [],
        humanOverride: existing?.humanOverride,
        policyCategories: (fx.policy_categories as string[] | undefined) ?? existing?.policyCategories,
        revisionHistory: existing?.revisionHistory ?? [],
        flight: {
          start: fxFlight.start ?? existing?.flight.start ?? now,
          end: fxFlight.end ?? existing?.flight.end ?? defaultFlightEnd,
        },
        mode: (fx.mode as GovernancePlanState['mode']) ?? existing?.mode ?? 'enforce',
        committedBudget: existing?.committedBudget ?? 0,
        committedByType: existing?.committedByType ?? {},
        syncedAt: existing?.syncedAt ?? now,
      });
    },

    async seedMediaBuy(mediaBuyId, fixture) {
      const fx = (fixture ?? {}) as Record<string, unknown>;
      enforceMapCap(session.mediaBuys, mediaBuyId, 'media buys');
      const existing = session.mediaBuys.get(mediaBuyId);
      const now = new Date().toISOString();
      session.mediaBuys.set(mediaBuyId, {
        mediaBuyId,
        accountRef:
          (fx.account as AccountRef | undefined)
          ?? existing?.accountRef
          ?? { brand: { domain: 'acmeoutdoor.example' } },
        brandRef: (fx.brand as BrandRef | undefined) ?? existing?.brandRef,
        status: (fx.status as string | undefined) ?? existing?.status ?? 'active',
        currency: (fx.currency as string | undefined) ?? existing?.currency ?? 'USD',
        packages: (fx.packages as MediaBuyState['packages']) ?? existing?.packages ?? [],
        startTime:
          (fx.start_time as string | undefined) ?? existing?.startTime ?? now,
        endTime:
          (fx.end_time as string | undefined)
          ?? existing?.endTime
          ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
        revision: existing?.revision ?? 1,
        confirmedAt: existing?.confirmedAt ?? now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        history: existing?.history ?? [{
          revision: 1,
          timestamp: now,
          actor: 'seller',
          action: 'seeded',
          summary: 'Media buy seeded via comply_test_controller.seed_media_buy',
        }],
      });
    },
  };
}

// ── Local scenarios (not in SDK's CONTROLLER_SCENARIOS yet) ───────

/** Scenarios this wrapper handles before delegating to the SDK dispatcher. The SDK's
 * `CONTROLLER_SCENARIOS` enum is closed; new scenarios from spec PRs land here until
 * the SDK adopts them. Listed in the tool's input enum and merged into list_scenarios
 * responses so storyboards can detect support.
 *
 * TODO: when the SDK ships native `force_create_media_buy_arm` (tracked at
 * adcontextprotocol/adcp-client — the dedup below means it is safe to leave this
 * entry in place during the transition; remove once a release has landed and the
 * cross-impl tests no longer rely on it). */
const LOCAL_SCENARIOS = ['force_create_media_buy_arm', 'force_task_completion', 'seed_creative_format'] as const;

// ── Tool definition ───────────────────────────────────────────────

// `Array.from(new Set(...))` dedups in case the SDK adopts a local scenario
// natively. Without this, both the input enum and the list_scenarios response
// would carry the same scenario name twice the moment the SDK catches up.
const SCENARIO_ENUM = Array.from(new Set([
  'list_scenarios',
  ...Object.values(CONTROLLER_SCENARIOS),
  ...LOCAL_SCENARIOS,
])) as readonly string[];

// JSON Schema equivalent of the SDK's `TOOL_INPUT_SHAPE`, extended with
// top-level `account` (sandbox gate) and `brand` (session keying) — both
// exempt extensions per the SDK's documented wrapper pattern.
export const COMPLY_TEST_CONTROLLER_TOOL = {
  name: 'comply_test_controller',
  description: 'Forces seller-side state transitions that a buyer agent cannot trigger directly — creative review outcomes, account status changes, delivery data, budget consumption. Sandbox only (requires account.sandbox: true). NOT for normal buyer operations. Call with scenario: "list_scenarios" first to see available scenarios and required params.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  execution: { taskSupport: 'forbidden' as const },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scenario: {
        type: 'string',
        enum: [...SCENARIO_ENUM],
        description: 'The seller-side transition to trigger.',
      },
      params: {
        type: 'object',
        description: 'Scenario-specific parameters. Call list_scenarios to see required and optional params per scenario. Omit for list_scenarios.',
      },
      account: { type: 'object' },
      brand: { type: 'object' },
    },
    required: ['scenario'],
  },
};

// ── Main handler ──────────────────────────────────────────────────

// Sanitizer note: the framework path registers this tool via `customTools`,
// which bypasses the SDK dispatcher's `finalize()` + `sanitizeAdcpErrorEnvelope`
// applied to spec tools. Today this handler never emits an `adcp_error`
// envelope (its only error shape is the scenario-level `{ success: false,
// error: '<code>' }` shape handleTestControllerRequest owns, plus the
// hand-rolled `{ success: false, error: 'FORBIDDEN' }` below), so the missing
// sanitizer is not a live leak. If a future edit ever returns `{ adcp_error:
// { code: 'IDEMPOTENCY_CONFLICT', recovery, ... } }` (or any code with a
// restricted ADCP_ERROR_FIELD_ALLOWLIST entry), route it through
// `@adcp/client/server`'s `adcpError()` builder — the builder filters at
// construction time and gives the dispatcher's invariant the same guarantee
// spec tools get for free.
export async function handleComplyTestController(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  const rawArgs = args as Record<string, unknown>;

  // Sandbox gate — spec: "If a comply_test_controller call references a
  // non-sandbox account, the controller MUST return FORBIDDEN." The
  // training agent is sandbox-only by deployment (the tool only lists on
  // sandbox connections), so a caller hitting this endpoint is by
  // definition in sandbox. Reject ONLY when the request explicitly
  // declares `account.sandbox: false` (an attempt to target a named
  // production account) — default-to-allow matches the storyboards
  // (`deterministic_testing`, etc.) which don't include `account` at all
  // on error-surface probes.
  const account = rawArgs.account as { sandbox?: boolean } | undefined;
  if (account && account.sandbox === false) {
    return {
      success: false,
      error: 'FORBIDDEN',
      error_detail: 'comply_test_controller cannot target non-sandbox accounts',
    };
  }

  const sessionKey = sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId);
  const session = await getSession(sessionKey);

  // Pre-dispatch local scenarios the SDK doesn't know about yet. The SDK's
  // dispatcher would return UNKNOWN_SCENARIO for these, so handle them before
  // we delegate. New scenarios from spec PRs land here until adopted upstream.
  const scenario = rawArgs.scenario;
  if (scenario === 'force_create_media_buy_arm') {
    return handleForceCreateMediaBuyArm(session, rawArgs);
  }
  if (scenario === 'force_task_completion') {
    return handleForceTaskCompletion(sessionKey, rawArgs);
  }
  // seed_creative_format is a training-agent extension not in the SDK's
  // CONTROLLER_SCENARIOS. Handle it before the SDK dispatcher so the SDK
  // doesn't return UNKNOWN_SCENARIO. Idempotency (same ID + same fixture
  // succeeds; same ID + different fixture → INVALID_STATE) is enforced
  // inline to match the guarantee handleTestControllerRequest provides for
  // the other seed_* scenarios via SEED_CACHE. agent_url is stamped at
  // write time so any future reader gets a schema-valid format_id without
  // knowing the agent's URL.
  if (scenario === 'seed_creative_format') {
    const params = (rawArgs.params ?? {}) as Record<string, unknown>;
    const formatId = params.format_id as string | undefined;
    if (!formatId) {
      return { success: false, error: 'INVALID_PARAMS', error_detail: 'params.format_id is required for seed_creative_format' };
    }
    const fixture = (params.fixture ?? {}) as Record<string, unknown>;
    const stored: Record<string, unknown> = {
      ...fixture,
      format_id: { agent_url: getAgentUrl(), id: formatId },
    };
    // Process-global pool (not session-scoped) — list_creative_formats has no
    // tenant identity in its request schema, so a session-scoped seed cannot
    // reliably reach the listing call. The training agent is sandbox-only and
    // the controller is process-scoped anyway, so global scope is correct
    // here. Other seed_* scenarios (seed_creative, seed_media_buy) target
    // entities the listing call carries identity for and stay session-scoped.
    const existing = SEEDED_CREATIVE_FORMATS.get(formatId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(stored)) {
        return { success: false, error: 'INVALID_STATE', error_detail: `format_id "${formatId}" was already seeded with a different fixture — seed_creative_format is idempotent` };
      }
      return { success: true, message: `format_id "${formatId}" already seeded with the same fixture` };
    }
    if (SEEDED_CREATIVE_FORMATS.size >= MAX_SEEDED_CREATIVE_FORMATS) {
      return { success: false, error: 'INVALID_STATE', error_detail: `seeded creative formats cap reached (${MAX_SEEDED_CREATIVE_FORMATS})` };
    }
    SEEDED_CREATIVE_FORMATS.set(formatId, stored);
    // Mirror into session state so existing tests/inspection paths still see it.
    session.complyExtensions.seededCreativeFormats.set(formatId, stored);
    return { success: true, message: `Creative format "${formatId}" seeded — list_creative_formats will use the seeded catalog process-wide` };
  }

  const store = createStore(session);
  const sdkResponse = await handleTestControllerRequest(store, rawArgs, { seedCache: SEED_CACHE });

  // Augment list_scenarios with our local scenarios so storyboards detect support.
  // The SDK answers from store-method presence, which doesn't see the local handlers.
  // Dedup via Set so the day the SDK adopts a LOCAL_SCENARIOS entry natively, the
  // response doesn't carry the same name twice.
  if (
    scenario === 'list_scenarios'
    && sdkResponse
    && typeof sdkResponse === 'object'
    && (sdkResponse as { success?: boolean }).success === true
    && Array.isArray((sdkResponse as { scenarios?: unknown }).scenarios)
  ) {
    const r = sdkResponse as { success: true; scenarios: string[] } & Record<string, unknown>;
    return { ...r, scenarios: Array.from(new Set([...r.scenarios, ...LOCAL_SCENARIOS])) };
  }

  return sdkResponse;
}

/**
 * Register a single-shot directive that shapes the next create_media_buy call from
 * this session into a specific arm. Spec: `force_create_media_buy_arm` in
 * `comply-test-controller-request.json` and `docs/building/implementation/comply-test-controller.mdx`.
 *
 * Implements `arm: 'submitted'` only. `arm: 'input-required'` is reserved in the
 * spec but cannot be modeled today: there's no `INPUT_REQUIRED` value in the
 * canonical error-code enum (it's a task-status), and `create-media-buy-response.json`
 * does not yet have a fourth oneOf branch for the input-required envelope. Resolving
 * either of those is a spec change tracked separately; until then the training-agent
 * rejects the arm with INVALID_PARAMS so callers see a clear failure rather than an
 * off-spec response shape.
 *
 * The directive is consumed by `handleCreateMediaBuy` on the next call and cleared.
 * A second `force_create_media_buy_arm` before consumption overwrites the prior
 * directive — matches the spec's "the next call" semantics. Buyer-side
 * `idempotency_key` replay still wins for the submitted arm: the SDK's request-
 * idempotency cache wraps the handler, so a replayed create_media_buy returns the
 * cached submitted response without re-evaluating the empty directive slot.
 */
function handleForceCreateMediaBuyArm(session: SessionState, rawArgs: Record<string, unknown>): object {
  const params = rawArgs.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'force_create_media_buy_arm requires params',
    };
  }

  const arm = params.arm;
  if (arm === 'input-required') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail:
        "arm: 'input-required' is reserved in the spec but not yet implementable on a conformant response shape. "
        + "Use arm: 'submitted' or omit force_create_media_buy_arm.",
    };
  }
  if (arm !== 'submitted') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: `Invalid arm: ${String(arm)}. Must be 'submitted'.`,
    };
  }

  const taskId = params.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: "task_id is required when arm = 'submitted'",
    };
  }
  if (taskId.length > 128) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'task_id exceeds maxLength 128',
    };
  }

  const message = params.message;
  if (message !== undefined && (typeof message !== 'string' || message.length > 2000)) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'message must be a string up to 2000 characters',
    };
  }

  session.complyExtensions.forcedCreateMediaBuyArm = {
    arm,
    taskId,
    message: typeof message === 'string' ? message : undefined,
  };

  return {
    success: true,
    forced: { arm, task_id: taskId },
    message: `Next create_media_buy call from this sandbox account will return the submitted arm with task_id ${taskId}`,
  };
}

/**
 * Resolve a previously-registered task to `completed` with a buyer-supplied
 * result payload. Spec: `force_task_completion` in
 * `comply-test-controller-request.json` and the matching mdx section.
 *
 * The training-agent records completions in a process-global Map keyed by
 * (caller-supplied task_id) → ({ result, ownerKey }). Cross-account calls return
 * NOT_FOUND (per the spec MUST). Tasks already at `completed` with the same
 * result are idempotent no-ops; tasks at any other terminal state return
 * INVALID_TRANSITION.
 *
 * Buyer-side observability via tasks/get is intentionally **deferred** to a
 * follow-up. The MCP SDK's TaskStore generates task_ids server-side and exposes
 * no API for caller-supplied IDs, and the SDK's auto-registered tasks/get
 * returns the MCP Task shape rather than the AdCP `tasks-get-response.json`
 * shape — both gaps need fixing before a storyboard polling phase against the
 * training-agent can pass. This commit ships the controller-side primitive
 * (the directive write) so other reference sellers and the upstream SDK have a
 * concrete behavior to mirror; the storyboard extension lands once the
 * polling integration exists. See PR description for the deferred tracking.
 */
const FORCED_TASK_COMPLETIONS = new Map<string, { result: Record<string, unknown>; ownerKey: string; completedAt: string }>();
const MAX_FORCED_TASK_COMPLETIONS = 1000;

/** Test-only: clear the forced-completion pool. */
export function clearForcedTaskCompletions(): void {
  FORCED_TASK_COMPLETIONS.clear();
}

/** Test-only: read the forced-completion pool. */
export function getForcedTaskCompletions(): ReadonlyMap<string, { result: Record<string, unknown>; ownerKey: string; completedAt: string }> {
  return FORCED_TASK_COMPLETIONS;
}

function handleForceTaskCompletion(sessionKey: string, rawArgs: Record<string, unknown>): object {
  const params = rawArgs.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'force_task_completion requires params',
    };
  }

  const taskId = params.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'task_id is required',
    };
  }
  if (taskId.length > 128) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'task_id exceeds maxLength 128',
    };
  }

  const result = params.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'result is required and must be an object (validates against async-response-data.json)',
    };
  }

  // Soft 256 KB cap on result payloads, per the spec's recommendation. Bounds
  // sandbox-amplified storage/echo DoS against the seller's task store.
  const resultBytes = JSON.stringify(result).length;
  if (resultBytes > 256 * 1024) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: `result payload exceeds 256 KB (${resultBytes} bytes)`,
    };
  }

  const existing = FORCED_TASK_COMPLETIONS.get(taskId);
  if (existing) {
    // Cross-account check (spec MUST): NOT_FOUND for task_ids belonging to other
    // accounts, conventional "not yours" → "doesn't exist" treatment.
    if (existing.ownerKey !== sessionKey) {
      return {
        success: false,
        error: 'NOT_FOUND',
        error_detail: `Task "${taskId}" was not registered for this sandbox account`,
      };
    }
    // Idempotent replay: same params → no-op success.
    if (JSON.stringify(existing.result) === JSON.stringify(result)) {
      return {
        success: true,
        previous_state: 'completed',
        current_state: 'completed',
        message: `Task ${taskId} already completed with the same result`,
      };
    }
    // Diverging replay against a terminal task: INVALID_TRANSITION.
    return {
      success: false,
      error: 'INVALID_TRANSITION',
      error_detail: `Task "${taskId}" is already terminal (completed); cannot re-complete with diverging result`,
      current_state: 'completed',
    };
  }

  if (FORCED_TASK_COMPLETIONS.size >= MAX_FORCED_TASK_COMPLETIONS) {
    return {
      success: false,
      error: 'INVALID_STATE',
      error_detail: `Forced-completion cap reached (${MAX_FORCED_TASK_COMPLETIONS})`,
    };
  }

  FORCED_TASK_COMPLETIONS.set(taskId, {
    result: result as Record<string, unknown>,
    ownerKey: sessionKey,
    completedAt: new Date().toISOString(),
  });

  return {
    success: true,
    previous_state: 'submitted',
    current_state: 'completed',
    message: `Task ${taskId} transitioned from submitted to completed`,
  };
}

// Module-level seed-fixture cache enforces the spec's same-ID-different-
// fixture rejection rule across all seed calls in the process. Scoping per-
// process keeps it aligned with the CONTROLLER_SCENARIOS list being static.
const SEED_CACHE = createSeedFixtureCache();

// Process-global pool for seed_creative_format. list_creative_formats has no
// tenant identity in its request schema (it's a global catalog read), so a
// session-scoped seed pool cannot reliably reach the listing call. Mirrored
// into session state so any test that reads complyExtensions.seededCreativeFormats
// still sees it. Test-only — sandbox controller is process-scoped by design.
const SEEDED_CREATIVE_FORMATS = new Map<string, Record<string, unknown>>();
const MAX_SEEDED_CREATIVE_FORMATS = 100;

/** Test-only: clear the process-global seeded creative formats pool. */
export function clearSeededCreativeFormats(): void {
  SEEDED_CREATIVE_FORMATS.clear();
}

/** Test-only: read the process-global seeded creative formats pool. */
export function getSeededCreativeFormats(): ReadonlyMap<string, Record<string, unknown>> {
  return SEEDED_CREATIVE_FORMATS;
}
