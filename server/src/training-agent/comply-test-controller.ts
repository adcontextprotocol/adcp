/**
 * Comply test controller for the training agent.
 *
 * Implements the TestControllerStore interface from @adcp/client backed
 * by session state — state machine transition tables, delivery/budget
 * simulations, etc. Dispatch and error handling are local since the
 * SDK's handleTestControllerRequest is not publicly exported.
 */

import { TestControllerError } from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';
import type {
  TrainingContext,
  ToolArgs,
  SessionState,
  MediaBuyState,
  ComplyDeliveryAccumulator,
  ComplyBudgetSimulation,
} from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import { deriveStatus } from './task-handlers.js';

// ── State machine transition tables ───────────────────────────────

const CREATIVE_TRANSITIONS: Record<string, string[]> = {
  processing: ['pending_review', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['pending_review', 'archived'],
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

/**
 * Per-Map cap on `complyExtensions`. These Maps are keyed by caller-supplied
 * IDs (account_id, session_id, media_buy_id) and, since they are persisted
 * with the session, a sandbox caller could otherwise loop with fresh IDs
 * until the SDK's 5 MB session cap throws `PAYLOAD_TOO_LARGE` at flush —
 * which aborts the request after the response was sent. Cap here so the
 * rejection happens at the mutation site with a clear error code.
 */
const MAX_COMPLY_ENTRIES_PER_MAP = 1000;

function enforceComplyCap<V>(map: Map<string, V>, key: string, kind: string): void {
  if (!map.has(key) && map.size >= MAX_COMPLY_ENTRIES_PER_MAP) {
    throw new TestControllerError(
      'INVALID_STATE',
      `Too many ${kind} entries in this sandbox session (limit ${MAX_COMPLY_ENTRIES_PER_MAP}). Clear the session or reuse an existing id.`,
    );
  }
}

// ── Session extensions ────────────────────────────────────────────

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
      enforceComplyCap(ext.accountStatuses, accountId, 'account status');
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
        enforceComplyCap(ext.siSessions, sessionId, 'si session');
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
        enforceComplyCap(ext.deliverySimulations, mediaBuyId, 'delivery simulation');
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
      enforceComplyCap(ext.budgetSimulations, entityId, 'budget simulation');
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
  };
}

// ── Tool definition ───────────────────────────────────────────────

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
        enum: [
          'list_scenarios',
          'force_creative_status',
          'force_account_status',
          'force_media_buy_status',
          'force_session_status',
          'simulate_delivery',
          'simulate_budget_spend',
        ],
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

// ── Scenario dispatch ─────────────────────────────────────────────

const SCENARIO_MAP: Array<[keyof TestControllerStore, string]> = [
  ['forceCreativeStatus', 'force_creative_status'],
  ['forceAccountStatus', 'force_account_status'],
  ['forceMediaBuyStatus', 'force_media_buy_status'],
  ['forceSessionStatus', 'force_session_status'],
  ['simulateDelivery', 'simulate_delivery'],
  ['simulateBudgetSpend', 'simulate_budget_spend'],
];

function listScenarios(store: TestControllerStore): string[] {
  return SCENARIO_MAP
    .filter(([method]) => typeof store[method] === 'function')
    .map(([, scenario]) => scenario);
}

async function dispatch(store: TestControllerStore, input: Record<string, unknown>): Promise<object> {
  const scenario = input.scenario as string;
  if (!scenario) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'Missing required field: scenario' };
  }

  if (scenario === 'list_scenarios') {
    return { success: true, scenarios: listScenarios(store) };
  }

  const params = input.params as Record<string, unknown> | undefined;
  try {
    switch (scenario) {
      case 'force_creative_status':
        if (!store.forceCreativeStatus) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (!params?.creative_id || !params?.status) return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_creative_status requires params.creative_id and params.status' };
        return await store.forceCreativeStatus(params.creative_id as string, params.status as never, params.rejection_reason as string | undefined);

      case 'force_account_status':
        if (!store.forceAccountStatus) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (!params?.account_id || !params?.status) return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_account_status requires params.account_id and params.status' };
        return await store.forceAccountStatus(params.account_id as string, params.status as never);

      case 'force_media_buy_status':
        if (!store.forceMediaBuyStatus) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (!params?.media_buy_id || !params?.status) return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_media_buy_status requires params.media_buy_id and params.status' };
        return await store.forceMediaBuyStatus(params.media_buy_id as string, params.status as never, params.rejection_reason as string | undefined);

      case 'force_session_status': {
        if (!store.forceSessionStatus) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (!params?.session_id || !params?.status) return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_session_status requires params.session_id and params.status' };
        const validSessionStatuses = ['complete', 'terminated'];
        if (!validSessionStatuses.includes(params.status as string)) return { success: false, error: 'INVALID_PARAMS', error_detail: `Invalid session status: ${params.status}` };
        return await store.forceSessionStatus(params.session_id as string, params.status as 'complete' | 'terminated', params.termination_reason as string | undefined);
      }

      case 'simulate_delivery':
        if (!store.simulateDelivery) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (!params?.media_buy_id) return { success: false, error: 'INVALID_PARAMS', error_detail: 'simulate_delivery requires params.media_buy_id' };
        return await store.simulateDelivery(params.media_buy_id as string, {
          impressions: params.impressions as number | undefined,
          clicks: params.clicks as number | undefined,
          reported_spend: params.reported_spend as { amount: number; currency: string } | undefined,
          conversions: params.conversions as number | undefined,
        });

      case 'simulate_budget_spend':
        if (!store.simulateBudgetSpend) return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: `Scenario not supported: ${scenario}` };
        if (params?.spend_percentage === undefined || params?.spend_percentage === null) return { success: false, error: 'INVALID_PARAMS', error_detail: 'simulate_budget_spend requires params.spend_percentage' };
        if (!params?.account_id && !params?.media_buy_id) return { success: false, error: 'INVALID_PARAMS', error_detail: 'simulate_budget_spend requires params.account_id or params.media_buy_id' };
        return await store.simulateBudgetSpend({
          account_id: params.account_id as string | undefined,
          media_buy_id: params.media_buy_id as string | undefined,
          spend_percentage: params.spend_percentage as number,
        });

      default:
        return { success: false, error: 'UNKNOWN_SCENARIO', error_detail: 'Unrecognized scenario name' };
    }
  } catch (err) {
    if (err instanceof TestControllerError) {
      return { success: false, error: err.code, error_detail: err.message, ...(err.currentState !== undefined && { current_state: err.currentState }) };
    }
    return { success: false, error: 'INTERNAL_ERROR', error_detail: 'An unexpected error occurred in the test controller store' };
  }
}

// ── Main handler ──────────────────────────────────────────────────

export async function handleComplyTestController(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  // Sandbox gating
  const account = (args as Record<string, unknown>).account as { sandbox?: boolean } | undefined;
  if (!account?.sandbox) {
    return {
      success: false,
      error: 'FORBIDDEN',
      error_detail: 'comply_test_controller is only available in sandbox mode',
    };
  }

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const store = createStore(session);
  return dispatch(store, args as Record<string, unknown>);
}

