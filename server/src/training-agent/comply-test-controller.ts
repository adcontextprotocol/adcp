/**
 * Comply test controller for the training agent.
 *
 * Implements the comply_test_controller tool per the AdCP compliance
 * test controller spec. Enables deterministic lifecycle testing by
 * forcing seller-side state transitions in sandbox mode.
 */

import type { TrainingContext, ToolArgs, SessionState, MediaBuyState, CreativeState } from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';

// ── State machine transition tables ───────────────────────────────

/** Valid transitions per creative status. */
const CREATIVE_TRANSITIONS: Record<string, string[]> = {
  processing: ['pending_review', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['archived'],
  rejected: ['processing'],
  archived: ['approved'],
};

/** Valid transitions per account status. */
const ACCOUNT_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ['active', 'rejected'],
  active: ['payment_required', 'suspended', 'closed'],
  payment_required: ['active', 'suspended', 'closed'],
  suspended: ['active', 'payment_required', 'closed'],
  rejected: [],   // terminal
  closed: [],     // terminal
};

const ACCOUNT_TERMINAL = new Set(['rejected', 'closed']);

/** Valid transitions per media buy status. */
const MEDIA_BUY_TRANSITIONS: Record<string, string[]> = {
  pending_activation: ['active', 'rejected', 'canceled'],
  active: ['paused', 'completed', 'canceled'],
  paused: ['active', 'completed', 'canceled'],
  completed: [],   // terminal
  rejected: [],    // terminal
  canceled: [],    // terminal
};

const MEDIA_BUY_TERMINAL = new Set(['completed', 'rejected', 'canceled']);

/** Valid transitions per SI session status. */
const SI_SESSION_TRANSITIONS: Record<string, string[]> = {
  active: ['pending_handoff', 'complete', 'terminated'],
  pending_handoff: ['complete', 'terminated'],
  complete: [],     // terminal
  terminated: [],   // terminal
};

const SI_SESSION_TERMINAL = new Set(['complete', 'terminated']);

// ── All supported scenarios ───────────────────────────────────────

const SUPPORTED_SCENARIOS = [
  'force_creative_status',
  'force_account_status',
  'force_media_buy_status',
  'force_session_status',
  'simulate_delivery',
  'simulate_budget_spend',
] as const;

type Scenario = typeof SUPPORTED_SCENARIOS[number] | 'list_scenarios';

// ── Session extensions for comply test controller ─────────────────
// We store account status, SI sessions, delivery simulation data, and
// budget simulation data as Maps on the session via a WeakMap so we
// don't need to modify the core SessionState type.

interface ComplyExtensions {
  accountStatuses: Map<string, string>;
  siSessions: Map<string, { status: string; terminationReason?: string }>;
  deliverySimulations: Map<string, DeliveryAccumulator>;
  budgetSimulations: Map<string, BudgetSimulation>;
}

interface DeliveryAccumulator {
  impressions: number;
  clicks: number;
  reportedSpend: { amount: number; currency: string };
  conversions: number;
}

interface BudgetSimulation {
  spendPercentage: number;
  computedSpend: { amount: number; currency: string };
  budget: { amount: number; currency: string };
}

const complyExtensions = new WeakMap<SessionState, ComplyExtensions>();

function getExtensions(session: SessionState): ComplyExtensions {
  let ext = complyExtensions.get(session);
  if (!ext) {
    ext = {
      accountStatuses: new Map(),
      siSessions: new Map(),
      deliverySimulations: new Map(),
      budgetSimulations: new Map(),
    };
    complyExtensions.set(session, ext);
  }
  return ext;
}

/** Get delivery simulation data for a media buy (used by get_media_buy_delivery). */
export function getDeliverySimulation(session: SessionState, mediaBuyId: string): DeliveryAccumulator | undefined {
  return complyExtensions.get(session)?.deliverySimulations.get(mediaBuyId);
}

/** Get budget simulation data for an entity (used by get_account_financials). */
export function getBudgetSimulation(session: SessionState, entityId: string): BudgetSimulation | undefined {
  return complyExtensions.get(session)?.budgetSimulations.get(entityId);
}

/** Get account status set by comply test controller. */
export function getAccountStatus(session: SessionState, accountId: string): string | undefined {
  return complyExtensions.get(session)?.accountStatuses.get(accountId);
}

// ── Request types ─────────────────────────────────────────────────

interface ComplyRequest extends ToolArgs {
  scenario: Scenario;
  params?: Record<string, unknown>;
}

// ── Tool definition ───────────────────────────────────────────────

export const COMPLY_TEST_CONTROLLER_TOOL = {
  name: 'comply_test_controller',
  description: 'Triggers seller-side state transitions for compliance testing. Sandbox only. Call with scenario: "list_scenarios" to discover available scenarios and their required params.',
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
        description: 'Scenario-specific parameters. Omit for list_scenarios.',
      },
      account: { type: 'object' },
      brand: { type: 'object' },
    },
    required: ['scenario'],
  },
};

// ── Main handler ──────────────────────────────────────────────────

export function handleComplyTestController(args: ToolArgs, ctx: TrainingContext): object {
  const req = args as unknown as ComplyRequest;

  // Sandbox gating: comply_test_controller is only available in sandbox mode
  const account = (args as Record<string, unknown>).account as { sandbox?: boolean } | undefined;
  if (!account?.sandbox) {
    return {
      success: false,
      error: 'FORBIDDEN',
      error_detail: 'comply_test_controller is only available in sandbox mode',
    };
  }

  const scenario = req.scenario;

  if (scenario === 'list_scenarios') {
    return { success: true, scenarios: [...SUPPORTED_SCENARIOS] };
  }

  if (!SUPPORTED_SCENARIOS.includes(scenario as typeof SUPPORTED_SCENARIOS[number])) {
    return {
      success: false,
      error: 'UNKNOWN_SCENARIO',
      error_detail: `Scenario "${String(scenario).slice(0, 100)}" is not supported by this seller`,
    };
  }

  if (!req.params) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: `params is required for scenario "${scenario}"`,
    };
  }

  const session = getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  switch (scenario) {
    case 'force_creative_status':
      return handleForceCreativeStatus(session, req.params);
    case 'force_account_status':
      return handleForceAccountStatus(session, req.params);
    case 'force_media_buy_status':
      return handleForceMediaBuyStatus(session, req.params);
    case 'force_session_status':
      return handleForceSessionStatus(session, req.params);
    case 'simulate_delivery':
      return handleSimulateDelivery(session, req.params);
    case 'simulate_budget_spend':
      return handleSimulateBudgetSpend(session, req.params);
    default:
      return {
        success: false,
        error: 'UNKNOWN_SCENARIO',
        error_detail: `Scenario "${scenario}" is not supported`,
      };
  }
}

// ── force_creative_status ─────────────────────────────────────────

function handleForceCreativeStatus(session: SessionState, params: Record<string, unknown>): object {
  const creativeId = params.creative_id as string | undefined;
  const targetStatus = params.status as string | undefined;

  if (!creativeId || !targetStatus) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'creative_id and status are required',
    };
  }

  const creative = session.creatives.get(creativeId);
  if (!creative) {
    return {
      success: false,
      error: 'NOT_FOUND',
      error_detail: `Creative ${creativeId} not found`,
      current_state: null,
    };
  }

  const currentStatus = creative.status;

  // Idempotent: same status is a no-op success
  if (currentStatus === targetStatus) {
    return {
      success: true,
      previous_state: currentStatus,
      current_state: targetStatus,
      message: `Creative ${creativeId} is already ${targetStatus}`,
    };
  }

  // Validate transition
  const validTargets = CREATIVE_TRANSITIONS[currentStatus];
  if (!validTargets || !validTargets.includes(targetStatus)) {
    return {
      success: false,
      error: 'INVALID_TRANSITION',
      error_detail: `Cannot transition creative from ${currentStatus} to ${targetStatus}`,
      current_state: currentStatus,
    };
  }

  // Require rejection_reason when rejecting
  if (targetStatus === 'rejected' && !params.rejection_reason) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'rejection_reason is required when status = rejected',
      current_state: currentStatus,
    };
  }

  creative.status = targetStatus;

  return {
    success: true,
    previous_state: currentStatus,
    current_state: targetStatus,
    message: `Creative ${creativeId} transitioned from ${currentStatus} to ${targetStatus}`,
  };
}

// ── force_account_status ──────────────────────────────────────────

function handleForceAccountStatus(session: SessionState, params: Record<string, unknown>): object {
  const accountId = params.account_id as string | undefined;
  const targetStatus = params.status as string | undefined;

  if (!accountId || !targetStatus) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'account_id and status are required',
    };
  }

  const ext = getExtensions(session);

  // Accounts are implicitly "active" when they have media buys but no explicit status set
  const currentStatus = ext.accountStatuses.get(accountId) ?? 'active';

  // Idempotent
  if (currentStatus === targetStatus) {
    return {
      success: true,
      previous_state: currentStatus,
      current_state: targetStatus,
      message: `Account ${accountId} is already ${targetStatus}`,
    };
  }

  // Validate transition
  const validTargets = ACCOUNT_TRANSITIONS[currentStatus];
  if (!validTargets || !validTargets.includes(targetStatus)) {
    const detail = ACCOUNT_TERMINAL.has(currentStatus)
      ? `Cannot transition account from ${currentStatus} to ${targetStatus} — ${currentStatus} is terminal`
      : `Cannot transition account from ${currentStatus} to ${targetStatus}`;
    return {
      success: false,
      error: 'INVALID_TRANSITION',
      error_detail: detail,
      current_state: currentStatus,
    };
  }

  ext.accountStatuses.set(accountId, targetStatus);

  return {
    success: true,
    previous_state: currentStatus,
    current_state: targetStatus,
    message: `Account ${accountId} transitioned from ${currentStatus} to ${targetStatus}`,
  };
}

// ── force_media_buy_status ────────────────────────────────────────

function findMediaBuy(session: SessionState, mediaBuyId: string): MediaBuyState | undefined {
  return session.mediaBuys.get(mediaBuyId);
}

function handleForceMediaBuyStatus(session: SessionState, params: Record<string, unknown>): object {
  const mediaBuyId = params.media_buy_id as string | undefined;
  const targetStatus = params.status as string | undefined;

  if (!mediaBuyId || !targetStatus) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'media_buy_id and status are required',
    };
  }

  const mb = findMediaBuy(session, mediaBuyId);
  if (!mb) {
    return {
      success: false,
      error: 'NOT_FOUND',
      error_detail: `Media buy ${mediaBuyId} not found`,
      current_state: null,
    };
  }

  const currentStatus = mb.status;

  // Idempotent
  if (currentStatus === targetStatus) {
    return {
      success: true,
      previous_state: currentStatus,
      current_state: targetStatus,
      message: `Media buy ${mediaBuyId} is already ${targetStatus}`,
    };
  }

  // Validate transition
  const validTargets = MEDIA_BUY_TRANSITIONS[currentStatus];
  if (!validTargets || !validTargets.includes(targetStatus)) {
    const detail = MEDIA_BUY_TERMINAL.has(currentStatus)
      ? `Cannot transition media buy from ${currentStatus} to ${targetStatus} — ${currentStatus} is terminal`
      : `Cannot transition media buy from ${currentStatus} to ${targetStatus}`;
    return {
      success: false,
      error: 'INVALID_TRANSITION',
      error_detail: detail,
      current_state: currentStatus,
    };
  }

  // Require rejection_reason when rejecting
  if (targetStatus === 'rejected' && !params.rejection_reason) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'rejection_reason is required when status = rejected',
      current_state: currentStatus,
    };
  }

  const now = new Date().toISOString();
  mb.status = targetStatus;
  mb.updatedAt = now;

  // Record cancellation metadata
  if (targetStatus === 'canceled') {
    mb.canceledAt = now;
    mb.canceledBy = 'seller';
    mb.cancellationReason = (params.rejection_reason as string) || 'Forced by comply test controller';
  }

  mb.history.push({
    revision: mb.revision,
    timestamp: now,
    actor: 'seller',
    action: `status_forced_to_${targetStatus}`,
    summary: `Comply test controller forced status to ${targetStatus}`,
  });

  return {
    success: true,
    previous_state: currentStatus,
    current_state: targetStatus,
    message: `Media buy ${mediaBuyId} transitioned from ${currentStatus} to ${targetStatus}`,
  };
}

// ── force_session_status ──────────────────────────────────────────

function handleForceSessionStatus(session: SessionState, params: Record<string, unknown>): object {
  const sessionId = params.session_id as string | undefined;
  const targetStatus = params.status as string | undefined;

  if (!sessionId || !targetStatus) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'session_id and status are required',
    };
  }

  // Only terminal statuses are valid targets
  if (!SI_SESSION_TERMINAL.has(targetStatus)) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: `Only terminal statuses (complete, terminated) are valid targets, got "${targetStatus}"`,
    };
  }

  const ext = getExtensions(session);
  const siSession = ext.siSessions.get(sessionId);

  if (!siSession) {
    // SI sessions are created implicitly — if we haven't seen it, assume it's active
    // (a real agent would track sessions via initiate_session)
    // For comply testing, treat unknown session IDs as active
    if (targetStatus === 'terminated' && !params.termination_reason) {
      return {
        success: false,
        error: 'INVALID_PARAMS',
        error_detail: 'termination_reason is required when status = terminated',
      };
    }

    ext.siSessions.set(sessionId, { status: targetStatus, terminationReason: params.termination_reason as string });

    return {
      success: true,
      previous_state: 'active',
      current_state: targetStatus,
      message: `Session ${sessionId} transitioned from active to ${targetStatus}`,
    };
  }

  const currentStatus = siSession.status;

  // Idempotent
  if (currentStatus === targetStatus) {
    return {
      success: true,
      previous_state: currentStatus,
      current_state: targetStatus,
      message: `Session ${sessionId} is already ${targetStatus}`,
    };
  }

  // Validate transition
  const validTargets = SI_SESSION_TRANSITIONS[currentStatus];
  if (!validTargets || !validTargets.includes(targetStatus)) {
    const detail = SI_SESSION_TERMINAL.has(currentStatus)
      ? `Cannot transition session from ${currentStatus} to ${targetStatus} — ${currentStatus} is terminal`
      : `Cannot transition session from ${currentStatus} to ${targetStatus}`;
    return {
      success: false,
      error: 'INVALID_TRANSITION',
      error_detail: detail,
      current_state: currentStatus,
    };
  }

  if (targetStatus === 'terminated' && !params.termination_reason) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'termination_reason is required when status = terminated',
    };
  }

  siSession.status = targetStatus;
  if (params.termination_reason) {
    siSession.terminationReason = params.termination_reason as string;
  }

  return {
    success: true,
    previous_state: currentStatus,
    current_state: targetStatus,
    message: `Session ${sessionId} transitioned from ${currentStatus} to ${targetStatus}`,
  };
}

// ── simulate_delivery ─────────────────────────────────────────────

function handleSimulateDelivery(session: SessionState, params: Record<string, unknown>): object {
  const mediaBuyId = params.media_buy_id as string | undefined;

  if (!mediaBuyId) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'media_buy_id is required',
    };
  }

  const mb = findMediaBuy(session, mediaBuyId);
  if (!mb) {
    return {
      success: false,
      error: 'NOT_FOUND',
      error_detail: `Media buy ${mediaBuyId} not found`,
      current_state: null,
    };
  }

  const impressions = (params.impressions as number) || 0;
  const clicks = (params.clicks as number) || 0;
  const conversions = (params.conversions as number) || 0;
  const reportedSpend = params.reported_spend as { amount: number; currency: string } | undefined;

  const ext = getExtensions(session);
  let cumulative = ext.deliverySimulations.get(mediaBuyId);

  if (!cumulative) {
    cumulative = {
      impressions: 0,
      clicks: 0,
      reportedSpend: { amount: 0, currency: reportedSpend?.currency || mb.currency },
      conversions: 0,
    };
    ext.deliverySimulations.set(mediaBuyId, cumulative);
  }

  // Additive
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
}

// ── simulate_budget_spend ─────────────────────────────────────────

function handleSimulateBudgetSpend(session: SessionState, params: Record<string, unknown>): object {
  const accountId = params.account_id as string | undefined;
  const mediaBuyId = params.media_buy_id as string | undefined;
  const spendPercentage = params.spend_percentage as number | undefined;

  if (spendPercentage === undefined || spendPercentage === null) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'spend_percentage is required',
    };
  }

  if (spendPercentage < 0 || spendPercentage > 100) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'spend_percentage must be between 0 and 100',
    };
  }

  if (!accountId && !mediaBuyId) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'At least one of account_id or media_buy_id is required',
    };
  }

  // Find budget from media buy if specified
  let budgetAmount = 0;
  let currency = 'USD';
  const entityId = mediaBuyId || accountId!;

  if (mediaBuyId) {
    const mb = findMediaBuy(session, mediaBuyId);
    if (!mb) {
      return {
        success: false,
        error: 'NOT_FOUND',
        error_detail: `Media buy ${mediaBuyId} not found`,
        current_state: null,
      };
    }
    // Sum package budgets as the media buy budget
    budgetAmount = mb.packages.reduce((sum, pkg) => sum + pkg.budget, 0);
    currency = mb.currency;
  } else {
    // Account-level budget: sum all media buy budgets in this session for this account
    for (const [, mb] of session.mediaBuys) {
      if (mb.accountRef?.account_id === accountId) {
        budgetAmount += mb.packages.reduce((sum, pkg) => sum + pkg.budget, 0);
        currency = mb.currency;
      }
    }
  }

  if (budgetAmount <= 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: `No budget configured for ${mediaBuyId ? 'media buy' : 'account'} ${entityId}`,
    };
  }

  const computedSpend = Math.round(budgetAmount * (spendPercentage / 100) * 100) / 100;

  const ext = getExtensions(session);
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
}
