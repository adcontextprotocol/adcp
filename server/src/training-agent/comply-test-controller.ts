/**
 * Training-agent wrapper around the SDK's comply_test_controller.
 *
 * The SDK owns the scenario dispatcher, response envelope, and per-scenario
 * enum validation (`@adcp/sdk` exports `handleTestControllerRequest`,
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
} from '@adcp/sdk';
import type { TestControllerStore } from '@adcp/sdk';
import type { WebhookAuthentication, WebhookEmitResult } from '@adcp/sdk/server';
import type { BrandReference } from '@adcp/sdk';
import type {
  TrainingContext,
  ToolArgs,
  SessionState,
  MediaBuyState,
  MediaBuyAvailableActionState,
  PackageState,
  CreativeState,
  GovernancePlanState,
  AccountRef,
  BrandRef,
  ComplyDeliveryAccumulator,
  ComplyBudgetSimulation,
} from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import { getAgentUrl } from './config.js';
import { randomUUID } from 'node:crypto';
import { getAccountNotificationSubscribers, seedAccountFixture } from './account-handlers.js';
import { verifyGovernanceToken, mintRevokedDemoToken, mintWrongAudDemoToken } from './governance-verify.js';
import { emitAccountNotificationWebhook } from './webhooks.js';
import { buildCatalog } from './product-factory.js';
import { getAllSignals } from './signal-providers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function getOrCreateDeliveryAccumulator(session: SessionState, mediaBuyId: string, currency: string): ComplyDeliveryAccumulator {
  const ext = session.complyExtensions;
  let cumulative = ext.deliverySimulations.get(mediaBuyId);
  if (!cumulative) {
    enforceMapCap(ext.deliverySimulations, mediaBuyId, 'delivery simulations');
    cumulative = {
      impressions: 0,
      clicks: 0,
      reportedSpend: { amount: 0, currency },
      conversions: 0,
    };
    ext.deliverySimulations.set(mediaBuyId, cumulative);
  }
  return cumulative;
}

function applyExtendedDeliveryParams(cumulative: ComplyDeliveryAccumulator, params: Record<string, unknown>) {
  if (typeof params.is_final === 'boolean') cumulative.isFinal = params.is_final;
  if (typeof params.finalized_at === 'string') cumulative.finalizedAt = params.finalized_at;
  if (typeof params.measurement_window === 'string') cumulative.measurementWindow = params.measurement_window;
  if (typeof params.reach === 'number') cumulative.reach = params.reach;
  if (typeof params.frequency === 'number') cumulative.frequency = params.frequency;
  if (params.reach_window && typeof params.reach_window === 'object' && !Array.isArray(params.reach_window)) {
    cumulative.reachWindow = params.reach_window as ComplyDeliveryAccumulator['reachWindow'];
  }
  if (params.viewability && typeof params.viewability === 'object' && !Array.isArray(params.viewability)) {
    cumulative.viewability = params.viewability as ComplyDeliveryAccumulator['viewability'];
  }
}

function extendedDeliverySnapshot(cumulative: ComplyDeliveryAccumulator): Record<string, unknown> {
  return {
    ...(cumulative.isFinal !== undefined ? { is_final: cumulative.isFinal } : {}),
    ...(cumulative.finalizedAt ? { finalized_at: cumulative.finalizedAt } : {}),
    ...(cumulative.measurementWindow ? { measurement_window: cumulative.measurementWindow } : {}),
    ...(cumulative.reach !== undefined ? { reach: cumulative.reach } : {}),
    ...(cumulative.frequency !== undefined ? { frequency: cumulative.frequency } : {}),
    ...(cumulative.reachWindow ? { reach_window: cumulative.reachWindow } : {}),
    ...(cumulative.viewability ? { viewability: cumulative.viewability } : {}),
  };
}

function normalizeSeedPackage(pkg: Record<string, unknown>, mbStart: string, mbEnd: string): PackageState {
  const packageId = String(pkg.packageId ?? pkg.package_id ?? `pkg_${randomUUID().slice(0, 8)}`);
  const hasProductId = pkg.productId !== undefined || pkg.product_id !== undefined;
  const productId = String(pkg.productId ?? pkg.product_id ?? 'seeded_product');
  const pricingOptionId = String(pkg.pricingOptionId ?? pkg.pricing_option_id ?? 'seeded_pricing');
  const creativeAssignments = pkg.creativeAssignments ?? pkg.creative_assignments;
  return {
    packageId,
    productId,
    budget: typeof pkg.budget === 'number' ? pkg.budget : 0,
    pricingOptionId,
    bidPrice: typeof pkg.bidPrice === 'number' ? pkg.bidPrice : typeof pkg.bid_price === 'number' ? pkg.bid_price : undefined,
    impressions: typeof pkg.impressions === 'number' ? pkg.impressions : undefined,
    paused: typeof pkg.paused === 'boolean' ? pkg.paused : false,
    canceled: typeof pkg.canceled === 'boolean' ? pkg.canceled : undefined,
    startTime: typeof pkg.startTime === 'string' ? pkg.startTime : typeof pkg.start_time === 'string' ? pkg.start_time : mbStart,
    endTime: typeof pkg.endTime === 'string' ? pkg.endTime : typeof pkg.end_time === 'string' ? pkg.end_time : mbEnd,
    formatIds: Array.isArray(pkg.formatIds) ? pkg.formatIds as PackageState['formatIds'] : Array.isArray(pkg.format_ids) ? pkg.format_ids as PackageState['formatIds'] : undefined,
    formatOptionRefs: Array.isArray(pkg.formatOptionRefs) ? pkg.formatOptionRefs : Array.isArray(pkg.format_option_refs) ? pkg.format_option_refs : undefined,
    formatKind: typeof pkg.formatKind === 'string' ? pkg.formatKind : typeof pkg.format_kind === 'string' ? pkg.format_kind : undefined,
    params: isRecord(pkg.params) ? pkg.params : undefined,
    creativeAssignments: Array.isArray(creativeAssignments) ? creativeAssignments.map(String) : [],
    targeting: (pkg.targeting ?? pkg.targeting_overlay) as PackageState['targeting'],
    context: isRecord(pkg.context) ? pkg.context : undefined,
    legacyOmitProductId: !hasProductId,
    optimizationGoals: Array.isArray(pkg.optimizationGoals) ? pkg.optimizationGoals as PackageState['optimizationGoals'] : Array.isArray(pkg.optimization_goals) ? pkg.optimization_goals as PackageState['optimizationGoals'] : undefined,
  };
}

function normalizeAvailableActions(actions: unknown): MediaBuyAvailableActionState[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const normalized: MediaBuyAvailableActionState[] = [];
  for (const entry of actions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const src = entry as Record<string, unknown>;
    if (typeof src.action !== 'string') continue;
    if (
      src.mode !== 'self_serve'
      && src.mode !== 'conditional_self_serve'
      && src.mode !== 'requires_approval'
    ) continue;
    const mode = src.mode;
    const sla = src.sla && typeof src.sla === 'object' && !Array.isArray(src.sla)
      ? src.sla as Record<string, unknown>
      : undefined;
    normalized.push({
      action: src.action,
      mode,
      ...(sla && {
        sla: {
          ...(typeof sla.response_max === 'string' && { response_max: sla.response_max }),
          ...(typeof sla.completion_max === 'string' && { completion_max: sla.completion_max }),
        },
      }),
      ...(typeof src.terms_ref === 'string' && { terms_ref: src.terms_ref }),
    });
  }
  return normalized.length ? normalized : undefined;
}

/** Get account status set by comply test controller. */
export function getAccountStatus(session: SessionState, accountId: string): string | undefined {
  return session.complyExtensions.accountStatuses.get(accountId);
}

// ── Helpers ───────────────────────────────────────────────────────

function findMediaBuy(session: SessionState, mediaBuyId: string): MediaBuyState | undefined {
  return session.mediaBuys.get(mediaBuyId);
}

/**
 * Propagate a creative status transition to any media buys whose packages
 * reference the creative. approved→rejected appends an impairment entry;
 * rejected→approved removes any matching open impairment. Idempotent on
 * re-emission of the same direction.
 *
 * Sibling resource types (audience, event_source, …) will get their own
 * propagators when their force_*_status scenarios land.
 */
function propagateCreativeImpairment(
  session: SessionState,
  creativeId: string,
  prev: string,
  next: string,
  reason?: string,
): void {
  const isOfflineTransition = next === 'rejected' && prev !== 'rejected';
  const isOnlineTransition = next !== 'rejected' && prev === 'rejected';
  if (!isOfflineTransition && !isOnlineTransition) return;

  for (const mb of session.mediaBuys.values()) {
    const dependentPackages = mb.packages
      .filter(pkg => pkg.creativeAssignments.includes(creativeId))
      .map(pkg => pkg.packageId);
    if (dependentPackages.length === 0) continue;

    if (isOfflineTransition) {
      const existing = (mb.impairments ?? []).find(
        i => i.resourceType === 'creative' && i.resourceId === creativeId,
      );
      if (existing) continue; // idempotent
      mb.impairments = [
        ...(mb.impairments ?? []),
        {
          impairmentId: `imp_${randomUUID().replace(/-/g, '')}`,
          resourceType: 'creative',
          resourceId: creativeId,
          packageIds: dependentPackages,
          transition: { from: prev, to: 'rejected' },
          reasonCode: 'content_rejected',
          ...(reason && { reason }),
          observedAt: new Date().toISOString(),
        },
      ];
      mb.updatedAt = new Date().toISOString();
    } else if (isOnlineTransition) {
      const before = mb.impairments?.length ?? 0;
      mb.impairments = (mb.impairments ?? []).filter(
        i => !(i.resourceType === 'creative' && i.resourceId === creativeId),
      );
      if (mb.impairments.length !== before) {
        mb.updatedAt = new Date().toISOString();
      }
    }
  }
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

function lifecycleReasonCode(prev: string, status: string): string {
  if (status === 'approved') return 'review_passed';
  if (status === 'pending_review') return 'seller_rereview';
  if (status === 'archived') return 'seller_archive';
  if (status === 'rejected') {
    if (prev === 'processing') return 'processing_failure';
    if (prev === 'pending_review') return 'review_failure';
    return 'policy_revocation';
  }
  return 'policy_revocation';
}

function webhookAuthenticationFromConfig(
  auth: { schemes: string[]; credentials?: string } | undefined,
): WebhookAuthentication | undefined {
  if (!auth?.credentials) return undefined;
  const schemes = auth.schemes.map(s => s.toLowerCase().replace(/-/g, '_'));
  if (schemes.includes('bearer')) return { type: 'bearer', token: auth.credentials };
  if (schemes.includes('hmac_sha256')) return { type: 'hmac_sha256', secret: auth.credentials };
  return undefined;
}

function redactWebhookActivityUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function recordWebhookActivityResult(
  creative: CreativeState,
  base: Omit<NonNullable<CreativeState['webhookActivity']>[number], 'completed_at' | 'attempt' | 'status' | 'url' | 'http_status_code' | 'response_time_ms' | 'error_message'>,
  subscriberUrl: string,
  result: WebhookEmitResult | undefined,
  error: unknown,
): void {
  const errorMessage = error instanceof Error ? error.message : (error ? String(error) : undefined);
  recordCreativeWebhookActivity(creative, {
    ...base,
    completed_at: new Date().toISOString(),
    attempt: result?.attempts ?? 1,
    status: result?.delivered ? 'success' : 'failed',
    url: redactWebhookActivityUrl(subscriberUrl),
    ...(result?.final_status && { http_status_code: result.final_status }),
    response_time_ms: 0,
    payload_size_bytes: base.payload_size_bytes,
    error_message: errorMessage ?? (result?.errors.length ? result.errors.join('; ') : null),
  });
}

async function emitCreativeStatusChanged(
  sessionKey: string,
  principal: string | undefined,
  creative: CreativeState,
  prev: string,
  status: string,
  reasonDetail?: string,
): Promise<void> {
  if (!['processing', 'pending_review', 'approved'].includes(prev)) return;
  const subscribers = getAccountNotificationSubscribers(sessionKey, 'creative.status_changed', principal, creative.accountId, creative.accountRef);
  if (subscribers.length === 0) return;
  const firedAt = new Date().toISOString();
  const notificationId = `cs_${creative.creativeId}_${randomUUID()}`;
  for (const subscriber of subscribers) {
    const idempotencyKey = randomUUID();
    const payload: Record<string, unknown> = {
      idempotency_key: idempotencyKey,
      notification_id: notificationId,
      notification_type: 'creative.status_changed',
      fired_at: firedAt,
      subscriber_id: subscriber.subscriberId,
      account_id: subscriber.accountId,
      creative_id: creative.creativeId,
      transition: {
        from: prev,
        to: status,
        observed_at: firedAt,
      },
      reason_code: lifecycleReasonCode(prev, status),
      ...(reasonDetail && { reason_detail: reasonDetail }),
      initiator: 'seller',
    };
    const activityBase = {
      idempotency_key: idempotencyKey,
      subscriber_id: subscriber.subscriberId,
      fired_at: firedAt,
      notification_type: 'creative.status_changed',
      payload_size_bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    } as const;
    try {
      const result = await emitAccountNotificationWebhook({
        url: subscriber.url,
        payload,
        operationId: `${subscriber.accountId}:${subscriber.subscriberId}:${notificationId}:${idempotencyKey}`,
        notificationType: 'creative.status_changed',
        authentication: webhookAuthenticationFromConfig(subscriber.authentication),
      });
      recordWebhookActivityResult(creative, activityBase, subscriber.url, result, undefined);
    } catch (err) {
      recordWebhookActivityResult(creative, activityBase, subscriber.url, undefined, err);
    }
  }
}

function recordCreativeWebhookActivity(
  creative: CreativeState,
  record: NonNullable<CreativeState['webhookActivity']>[number],
): void {
  creative.webhookActivity = [record, ...(creative.webhookActivity ?? [])].slice(0, 50);
}

function createStore(session: SessionState, sessionKey: string, principal?: string): TestControllerStore {
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
      propagateCreativeImpairment(session, creativeId, prev, status, rejectionReason);
      await emitCreativeStatusChanged(sessionKey, principal, creative, prev, status, rejectionReason);
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
      mb.complyControllerForced = true;
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
      const typedParams = params as Record<string, unknown>;

      const cumulative = getOrCreateDeliveryAccumulator(session, mediaBuyId, reportedSpend?.currency || mb.currency);

      cumulative.impressions += impressions;
      cumulative.clicks += clicks;
      cumulative.conversions += conversions;
      if (reportedSpend) {
        cumulative.reportedSpend.amount += reportedSpend.amount;
        cumulative.reportedSpend.currency = reportedSpend.currency;
      }
      applyExtendedDeliveryParams(cumulative, typedParams);

      const simulated: Record<string, unknown> = {};
      if (impressions) simulated.impressions = impressions;
      if (clicks) simulated.clicks = clicks;
      if (reportedSpend) simulated.reported_spend = reportedSpend;
      if (conversions) simulated.conversions = conversions;
      if (typedParams.reach !== undefined) simulated.reach = typedParams.reach;
      if (typedParams.frequency !== undefined) simulated.frequency = typedParams.frequency;
      if (typedParams.reach_window !== undefined) simulated.reach_window = typedParams.reach_window;
      if (typedParams.viewability !== undefined) simulated.viewability = typedParams.viewability;
      if (typedParams.is_final !== undefined) simulated.is_final = typedParams.is_final;
      if (typedParams.finalized_at !== undefined) simulated.finalized_at = typedParams.finalized_at;
      if (typedParams.measurement_window !== undefined) simulated.measurement_window = typedParams.measurement_window;

      return {
        success: true,
        simulated,
        cumulative: {
          impressions: cumulative.impressions,
          clicks: cumulative.clicks,
          reported_spend: cumulative.reportedSpend,
          conversions: cumulative.conversions,
          ...extendedDeliverySnapshot(cumulative),
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
        planAsSupplied: existing?.planAsSupplied ?? (fx as Record<string, unknown>),
      });
    },

    async seedMediaBuy(mediaBuyId, fixture) {
      const fx = (fixture ?? {}) as Record<string, unknown>;
      enforceMapCap(session.mediaBuys, mediaBuyId, 'media buys');
      const existing = session.mediaBuys.get(mediaBuyId);
      const now = new Date().toISOString();
      const startTime = (fx.start_time as string | undefined) ?? existing?.startTime ?? now;
      const endTime =
        (fx.end_time as string | undefined)
        ?? existing?.endTime
        ?? new Date(Date.now() + 30 * 86_400_000).toISOString();
      const packages = Array.isArray(fx.packages)
        ? fx.packages
            .filter(pkg => pkg && typeof pkg === 'object' && !Array.isArray(pkg))
            .map(pkg => normalizeSeedPackage(pkg as Record<string, unknown>, startTime, endTime))
        : existing?.packages ?? [];
      session.mediaBuys.set(mediaBuyId, {
        mediaBuyId,
        accountRef:
          (fx.account as AccountRef | undefined)
          ?? existing?.accountRef
          ?? { brand: { domain: 'acmeoutdoor.example' } },
        brandRef: (fx.brand as BrandRef | undefined) ?? existing?.brandRef,
        status: (fx.status as string | undefined) ?? existing?.status ?? 'active',
        currency: (fx.currency as string | undefined) ?? existing?.currency ?? 'USD',
        packages,
        availableActions: normalizeAvailableActions(fx.available_actions) ?? existing?.availableActions,
        startTime,
        endTime,
        revision: existing?.revision ?? 1,
        confirmedAt: existing?.confirmedAt ?? now,
        context: isRecord(fx.context) ? fx.context : existing?.context,
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
const LOCAL_SCENARIOS = [
  'force_create_media_buy_arm',
  'force_task_completion',
  'force_creative_purge',
  'force_wholesale_feed_webhook',
  'seed_account',
  'seed_creative_format',
  'seed_measurement_catalog',
  'query_provenance_audit_observations',
  'evaluate_distributed_brand_resolution',
  'verify_governance_token',
] as const;

function localScenariosFor(ctx: TrainingContext): string[] {
  return ctx.storyboardCompat?.version === '3.0'
    ? LOCAL_SCENARIOS.filter(s => s !== 'force_creative_purge' && s !== 'force_wholesale_feed_webhook' && s !== 'query_provenance_audit_observations')
    : [...LOCAL_SCENARIOS];
}

/**
 * verify_governance_token — run the JWS-profile seller verification checklist
 * against a supplied governance_context and return a per-step pass/fail trace.
 * The training agent is otherwise an issuer with no verification surface, so
 * this is what lets an S6 learner observe a token being ACCEPTED (valid) or
 * REJECTED (tampered → signature; wrong seller → aud; revoked kid → revocation).
 *
 * The verifier always checks against this seller's own fixed canonical aud —
 * the caller never supplies the reference value of a security check. The
 * rejection demos are shown by MINTING the offending token, not by moving the
 * verifier's goalposts.
 *
 * params: { token?, mode?: 'verify'|'revoked_demo'|'wrong_aud_demo',
 *           tamper?: 'signature'|'sub'|<anything-else> }
 */
async function handleVerifyGovernanceToken(rawArgs: Record<string, unknown>): Promise<object> {
  const params = (rawArgs.params ?? {}) as Record<string, unknown>;
  const mode = typeof params.mode === 'string' ? params.mode : 'verify';
  let token = typeof params.token === 'string' ? params.token : undefined;
  let note: string | undefined;
  if (mode === 'revoked_demo') {
    token = await mintRevokedDemoToken();
    note = 'Minted a token signed under a deliberately-revoked sandbox governance kid — watch the revocation step reject it.';
  } else if (mode === 'wrong_aud_demo') {
    token = await mintWrongAudDemoToken();
    note = 'Minted a validly-signed token bound to a different seller (aud) — watch the aud step reject it (confused deputy).';
  }
  if (!token) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'Provide params.token (a governance_context from sync_plans -> intent check_governance), or set params.mode to "revoked_demo" (revocation rejection) or "wrong_aud_demo" (confused-deputy aud rejection) to mint a demo token to verify. Add params.tamper to mutate a claim and watch the signature step reject it.',
    };
  }
  const tamper = typeof params.tamper === 'string' ? params.tamper : undefined;
  if (tamper) token = tamperGovernanceToken(token, tamper);
  const result = await verifyGovernanceToken(token);
  return {
    success: true,
    verdict: result.verdict,
    error_code: result.error_code,
    checklist: result.steps,
    ...(note ? { note } : {}),
    ...(tamper ? { tampered: tamper } : {}),
  };
}

/** Mutate a token to demonstrate rejection. Any payload edit breaks the signature
 * (step 7); 'signature' corrupts the signature segment directly. */
function tamperGovernanceToken(token: string, what: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) return token;
  if (what === 'signature') {
    const sig = parts[2];
    return `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Mutate a FIXED claim (never a user-controlled property name — that would
    // be property injection). Any payload edit breaks the signature, which is
    // the whole teaching point; `what` only selects which fixed claim to alter.
    if (what === 'sub') claims.sub = 'plan-swapped';
    else claims.aud = 'https://attacker.example/sales';
    return `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`;
  } catch {
    return token;
  }
}

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
// `@adcp/sdk/server`'s `adcpError()` builder — the builder filters at
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
  const params = (rawArgs.params ?? {}) as Record<string, unknown>;
  const isLiveModeProbe = rawArgs.scenario === 'force_creative_status'
    && params.creative_id === 'comply-live-mode-probe-000';
  if ((account && account.sandbox === false) || isLiveModeProbe) {
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
  if (scenario === 'evaluate_distributed_brand_resolution') {
    const params = isRecord(rawArgs.params) ? rawArgs.params : {};
    return {
      success: true,
      action: 'distributed_brand_resolution_evaluated',
      variant: typeof params.variant === 'string' ? params.variant : 'default',
      message: 'Distributed brand-resolution fixture evaluated successfully.',
    };
  }
  if (scenario === 'verify_governance_token') {
    return handleVerifyGovernanceToken(rawArgs);
  }
  if (scenario === 'force_upstream_unavailable') {
    const params = (rawArgs.params ?? {}) as Record<string, unknown>;
    const tool = typeof params.tool === 'string' ? params.tool : undefined;
    if (!tool) {
      return { success: false, error: 'INVALID_PARAMS', error_detail: 'params.tool is required for force_upstream_unavailable' };
    }
    session.complyExtensions.forcedUpstreamUnavailable = {
      tool,
      upstreamName: typeof params.upstream_name === 'string' ? params.upstream_name : undefined,
      createdAt: new Date().toISOString(),
    };
    return {
      success: true,
      action: 'upstream_forced_unavailable',
      summary: `Forced ${params.upstream_name ?? 'upstream'} unavailable for ${tool}`,
    };
  }
  if (scenario === 'force_creative_purge') {
    if (ctx.storyboardCompat?.version === '3.0') {
      return {
        success: false,
        error: 'UNKNOWN_SCENARIO',
        error_detail: 'force_creative_purge is not available in AdCP 3.0 compatibility mode',
      };
    }
    return handleForceCreativePurge(session, sessionKey, ctx.principal, rawArgs);
  }
  if (scenario === 'force_wholesale_feed_webhook') {
    if (ctx.storyboardCompat?.version === '3.0') {
      return {
        success: false,
        error: 'UNKNOWN_SCENARIO',
        error_detail: 'force_wholesale_feed_webhook is not available in AdCP 3.0 compatibility mode',
      };
    }
    return handleForceWholesaleFeedWebhook(sessionKey, ctx.principal, rawArgs);
  }
  if (scenario === 'seed_account') {
    return seedAccountFixture(rawArgs as ToolArgs, ctx);
  }
  if (scenario === 'seed_measurement_catalog') {
    return handleSeedMeasurementCatalog(session, rawArgs);
  }
  if (scenario === 'query_provenance_audit_observations') {
    if (ctx.storyboardCompat?.version === '3.0') {
      return {
        success: false,
        error: 'UNKNOWN_SCENARIO',
        error_detail: 'query_provenance_audit_observations is not available in AdCP 3.0 compatibility mode',
      };
    }
    return handleQueryProvenanceAuditObservations(session, rawArgs);
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

  // Pre-capture extended simulate_delivery fields before the SDK dispatcher strips
  // unknown params. The SDK's TestControllerStore.simulateDelivery interface can lag
  // this repo's controller schema, so rawArgs remains the compatibility path for
  // new delivery metrics until the SDK accepts them natively.
  if (scenario === 'simulate_delivery') {
    const params = (rawArgs.params ?? {}) as Record<string, unknown>;
    const mediaBuyId = params.media_buy_id as string | undefined;
    const vendorMetricValues = params.vendor_metric_values;
    const mb = mediaBuyId ? findMediaBuy(session, mediaBuyId) : undefined;
    if (mb) {
      const cumulative = getOrCreateDeliveryAccumulator(session, mediaBuyId!, mb.currency);
      applyExtendedDeliveryParams(cumulative, params);
      if (Array.isArray(vendorMetricValues) && vendorMetricValues.length > 0) {
        cumulative.vendorMetricValues = vendorMetricValues;
      }
    }
  }

  const store = createStore(session, sessionKey, ctx.principal);
  const sdkResponse = await handleTestControllerRequest(store, rawArgs, { seedCache: SEED_CACHE });

  if (
    scenario === 'simulate_delivery'
    && sdkResponse
    && typeof sdkResponse === 'object'
    && (sdkResponse as { success?: boolean }).success === true
  ) {
    const params = (rawArgs.params ?? {}) as Record<string, unknown>;
    const mediaBuyId = params.media_buy_id as string | undefined;
    const cumulative = mediaBuyId ? getDeliverySimulation(session, mediaBuyId) : undefined;
    const simulatedExtras: Record<string, unknown> = {};
    if (params.reach !== undefined) simulatedExtras.reach = params.reach;
    if (params.frequency !== undefined) simulatedExtras.frequency = params.frequency;
    if (params.reach_window !== undefined) simulatedExtras.reach_window = params.reach_window;
    if (params.viewability !== undefined) simulatedExtras.viewability = params.viewability;
    if (params.is_final !== undefined) simulatedExtras.is_final = params.is_final;
    if (params.finalized_at !== undefined) simulatedExtras.finalized_at = params.finalized_at;
    if (params.measurement_window !== undefined) simulatedExtras.measurement_window = params.measurement_window;
    if (Object.keys(simulatedExtras).length > 0 || cumulative) {
      const response = sdkResponse as unknown as Record<string, unknown>;
      return {
        ...response,
        simulated: {
          ...((response.simulated && typeof response.simulated === 'object') ? response.simulated as Record<string, unknown> : {}),
          ...simulatedExtras,
        },
        cumulative: {
          ...((response.cumulative && typeof response.cumulative === 'object') ? response.cumulative as Record<string, unknown> : {}),
          ...(cumulative ? extendedDeliverySnapshot(cumulative) : {}),
        },
      };
    }
  }

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
    const r = sdkResponse as unknown as { success: true; scenarios: string[] } & Record<string, unknown>;
    return { ...r, scenarios: Array.from(new Set([...r.scenarios, ...localScenariosFor(ctx)])) };
  }

  return sdkResponse;
}

function entityTypeForWholesaleEvent(eventType: string): 'product' | 'signal' | 'feed' | null {
  if (eventType.startsWith('product.')) return 'product';
  if (eventType.startsWith('signal.')) return 'signal';
  if (eventType === 'wholesale_feed.bulk_change') return 'feed';
  return null;
}

function defaultWholesaleProduct(productId: string): Record<string, unknown> {
  const product = buildCatalog()[0]?.product;
  return product
    ? { ...product, product_id: productId }
    : {
      product_id: productId,
      name: 'Training wholesale product',
      description: 'Synthetic wholesale feed product emitted by the training agent.',
      channels: ['display'],
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'po_training_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
    };
}

function defaultWholesaleSignal(signalId: string): Record<string, unknown> {
  const signal = getAllSignals()[0];
  const providerDomain = signal?.providerDomain ?? 'training-signals.example';
  return {
    signal_agent_segment_id: signalId,
    signal_ref: {
      scope: 'data_provider',
      data_provider_domain: providerDomain,
      signal_id: signalId,
    },
    name: signal?.name ?? 'Training wholesale signal',
    description: signal?.description ?? 'Synthetic wholesale feed signal emitted by the training agent.',
    value_type: signal?.valueType ?? 'binary',
    signal_type: signal?.signalType ?? 'marketplace',
    data_provider: signal?.providerName ?? 'Training Signals',
    coverage_percentage: signal?.coveragePercentage ?? 10,
    deployments: [{
      type: 'agent',
      agent_url: getAgentUrl(),
      is_live: false,
      estimated_activation_duration_minutes: 0,
    }],
    pricing_options: (signal?.pricingOptions ?? [{ pricingOptionId: 'po_training_signal_cpm', model: 'cpm', cpm: 1.5, currency: 'USD' }]).map(po => ({
      pricing_option_id: po.pricingOptionId,
      model: po.model,
      currency: po.currency,
      ...(po.model === 'cpm' && { cpm: po.cpm }),
      ...(po.model === 'percent_of_media' && { percent: po.percent, ...(po.maxCpm !== undefined && { max_cpm: po.maxCpm }) }),
      ...(po.model === 'flat_fee' && { amount: po.amount, period: po.period }),
    })),
    ...(signal?.valueType === 'categorical' && signal.categories ? { categories: signal.categories } : {}),
    ...(signal?.valueType === 'numeric' && signal.range ? { range: signal.range } : {}),
  };
}

function defaultWholesaleEventPayload(eventType: string, entityId: string, appliesTo: Record<string, unknown>): Record<string, unknown> {
  if (eventType === 'product.created' || eventType === 'product.updated') {
    return {
      product_id: entityId,
      product: defaultWholesaleProduct(entityId),
      ...(eventType === 'product.updated' && { changed_fields: ['pricing_options'] }),
      applies_to: appliesTo,
    };
  }
  if (eventType === 'product.priced') {
    return {
      product_id: entityId,
      pricing_options: [{ pricing_option_id: 'po_training_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
      applies_to: appliesTo,
    };
  }
  if (eventType === 'signal.created' || eventType === 'signal.updated') {
    return {
      signal_agent_segment_id: entityId,
      signal_ref: {
        scope: 'data_provider',
        data_provider_domain: getAllSignals()[0]?.providerDomain ?? 'training-signals.example',
        signal_id: entityId,
      },
      signal: defaultWholesaleSignal(entityId),
      ...(eventType === 'signal.updated' && { changed_fields: ['pricing_options'] }),
      applies_to: appliesTo,
    };
  }
  if (eventType === 'signal.priced') {
    return {
      signal_agent_segment_id: entityId,
      pricing_options: [{ pricing_option_id: 'po_training_signal_cpm', model: 'cpm', cpm: 1.5, currency: 'USD' }],
      applies_to: appliesTo,
    };
  }
  if (eventType === 'wholesale_feed.bulk_change') {
    return {
      summary: 'Training wholesale feed refresh',
      affected_entity_type: entityId === 'signal' ? 'signal' : 'product',
      affected_count: 1,
      recommendation: 'wholesale_resync',
      applies_to: appliesTo,
    };
  }
  if (eventType.startsWith('product.')) return { product_id: entityId, applies_to: appliesTo };
  if (eventType.startsWith('signal.')) return { signal_agent_segment_id: entityId, applies_to: appliesTo };
  return { applies_to: appliesTo };
}

async function handleForceWholesaleFeedWebhook(
  sessionKey: string,
  principal: string | undefined,
  rawArgs: Record<string, unknown>,
): Promise<object> {
  const params = (rawArgs.params ?? {}) as Record<string, unknown>;
  const eventType = typeof params.event_type === 'string' ? params.event_type : undefined;
  if (!eventType) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'force_wholesale_feed_webhook requires params.event_type' };
  }
  const entityType = entityTypeForWholesaleEvent(eventType);
  if (!entityType) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: `Unsupported wholesale feed event type: ${eventType}` };
  }
  const notificationType = eventType as Parameters<typeof getAccountNotificationSubscribers>[1];
  const accountRef = (rawArgs.account ?? params.account) as AccountRef | undefined;
  const subscribers = getAccountNotificationSubscribers(sessionKey, notificationType, principal, undefined, accountRef);
  const firedAt = new Date().toISOString();
  const notificationId = randomUUID();
  const cacheScope = params.cache_scope === 'account' ? 'account' : 'public';
  const appliesTo = cacheScope === 'account'
    ? { scope: 'account', ...(typeof params.account_id === 'string' ? { account_ids: [params.account_id] } : {}) }
    : { scope: 'public' };
  const entityId = typeof params.entity_id === 'string'
    ? params.entity_id
    : entityType === 'product'
      ? 'prod_training_wholesale'
      : entityType === 'signal'
        ? 'seg_training_wholesale'
        : 'product';
  const eventPayload = (params.payload && typeof params.payload === 'object')
    ? params.payload as Record<string, unknown>
    : defaultWholesaleEventPayload(eventType, entityId, appliesTo);
  const event = {
    event_id: notificationId,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    created_at: firedAt,
    payload: eventPayload,
  };
  const basePayload = {
    notification_id: notificationId,
    notification_type: eventType,
    fired_at: firedAt,
    wholesale_feed_version: typeof params.wholesale_feed_version === 'string' ? params.wholesale_feed_version : `training-${eventType}-v1`,
    cache_scope: cacheScope,
    event,
  };

  let delivered = 0;
  const failures: string[] = [];
  for (const subscriber of subscribers) {
    const idempotencyKey = `whk_${randomUUID()}`;
    const payload = {
      ...basePayload,
      idempotency_key: idempotencyKey,
      subscriber_id: subscriber.subscriberId,
      account_id: subscriber.accountId,
    };
    try {
      const result = await emitAccountNotificationWebhook({
        url: subscriber.url,
        payload,
        operationId: `${subscriber.accountId}:${subscriber.subscriberId}:${notificationId}:${idempotencyKey}`,
        notificationType: eventType,
        authentication: webhookAuthenticationFromConfig(subscriber.authentication),
      });
      if (result.delivered) {
        delivered += 1;
      } else {
        failures.push(...result.errors);
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    success: failures.length === 0,
    notification_type: eventType,
    subscribers: subscribers.length,
    delivered,
    ...(failures.length > 0 && { failures }),
  };
}

function measurementVendorCatalogKey(vendor: { domain?: unknown; brand_id?: unknown }): string | null {
  const domain = vendor.domain;
  if (typeof domain !== 'string' || domain.length === 0) return null;
  const brandId = typeof vendor.brand_id === 'string' ? vendor.brand_id : '';
  return `${domain.toLowerCase()}|${brandId}`;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return '"__cycle__"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v, seen)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson(record[k], seen)}`);
  return `{${entries.join(',')}}`;
}

function handleSeedMeasurementCatalog(session: SessionState, rawArgs: Record<string, unknown>): object {
  const params = rawArgs.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'seed_measurement_catalog requires params',
    };
  }

  const vendor = params.vendor as { domain?: unknown; brand_id?: unknown } | undefined;
  const key = vendor ? measurementVendorCatalogKey(vendor) : null;
  if (!vendor || !key) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'seed_measurement_catalog requires params.vendor.domain',
    };
  }
  const vendorDomain = (vendor.domain as string).toLowerCase();

  const rawMetrics = params.metrics;
  if (!Array.isArray(rawMetrics)) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'seed_measurement_catalog requires params.metrics[]',
    };
  }
  if (rawMetrics.length === 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'seed_measurement_catalog requires at least one metric',
    };
  }

  const metrics: Array<{ metric_id: string; [key: string]: unknown }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawMetrics.length; i++) {
    const metric = rawMetrics[i];
    if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
      return {
        success: false,
        error: 'INVALID_PARAMS',
        error_detail: `seed_measurement_catalog params.metrics[${i}] must be an object`,
      };
    }
    const entry = metric as Record<string, unknown>;
    if (typeof entry.metric_id !== 'string' || entry.metric_id.length === 0) {
      return {
        success: false,
        error: 'INVALID_PARAMS',
        error_detail: `seed_measurement_catalog params.metrics[${i}].metric_id is required`,
      };
    }
    if (seen.has(entry.metric_id)) {
      return {
        success: false,
        error: 'INVALID_PARAMS',
        error_detail: `seed_measurement_catalog duplicate metric_id "${entry.metric_id}"`,
      };
    }
    seen.add(entry.metric_id);
    metrics.push({ ...entry, metric_id: entry.metric_id });
  }
  metrics.sort((a, b) => a.metric_id.localeCompare(b.metric_id));

  const nextCatalog = {
    vendor: {
      domain: vendorDomain,
      ...(typeof vendor.brand_id === 'string' && { brand_id: vendor.brand_id }),
    },
    metrics,
  };
  const existing = session.complyExtensions.seededMeasurementCatalogs.get(key);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(nextCatalog)) {
      return {
        success: false,
        error: 'INVALID_PARAMS',
        error_detail: `Measurement catalog for ${vendorDomain} diverges from the previously seeded fixture`,
      };
    }
    return {
      success: true,
      message: 'Fixture re-seeded (equivalent)',
    };
  }

  enforceMapCap(session.complyExtensions.seededMeasurementCatalogs, key, 'seeded measurement catalogs');
  session.complyExtensions.seededMeasurementCatalogs.set(key, nextCatalog);

  return {
    success: true,
    message: `Measurement catalog for ${vendorDomain} seeded with ${metrics.length} metric(s)`,
  };
}

function purgeReasonCode(kind: 'soft' | 'hard', supplied: unknown): string {
  if (typeof supplied === 'string' && supplied.length > 0) return supplied;
  return kind === 'hard' ? 'legal_erasure' : 'retention_expired';
}

async function emitCreativePurged(
  sessionKey: string,
  principal: string | undefined,
  creative: CreativeState,
  purgeKind: 'soft' | 'hard',
  reasonCode: string,
  purgedAt: string,
  reasonDetail?: string,
): Promise<void> {
  const subscribers = getAccountNotificationSubscribers(sessionKey, 'creative.purged', principal, creative.accountId, creative.accountRef);
  if (subscribers.length === 0) return;
  const notificationId = `cp_${creative.creativeId}_${randomUUID()}`;
  for (const subscriber of subscribers) {
    const idempotencyKey = randomUUID();
    const payload: Record<string, unknown> = {
      idempotency_key: idempotencyKey,
      notification_id: notificationId,
      notification_type: 'creative.purged',
      fired_at: purgedAt,
      subscriber_id: subscriber.subscriberId,
      account_id: subscriber.accountId,
      creative_id: creative.creativeId,
      purge_kind: purgeKind,
      purged_at: purgedAt,
      reason_code: reasonCode,
      ...(reasonDetail && { reason_detail: reasonDetail }),
      initiator: purgeKind === 'hard' ? 'seller' : 'system',
    };
    const activityBase = {
      idempotency_key: idempotencyKey,
      subscriber_id: subscriber.subscriberId,
      fired_at: purgedAt,
      notification_type: 'creative.purged',
      payload_size_bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    } as const;
    try {
      const result = await emitAccountNotificationWebhook({
        url: subscriber.url,
        payload,
        operationId: `${subscriber.accountId}:${subscriber.subscriberId}:${notificationId}:${idempotencyKey}`,
        notificationType: 'creative.purged',
        authentication: webhookAuthenticationFromConfig(subscriber.authentication),
      });
      recordWebhookActivityResult(creative, activityBase, subscriber.url, result, undefined);
    } catch (err) {
      recordWebhookActivityResult(creative, activityBase, subscriber.url, undefined, err);
    }
  }
}

async function handleForceCreativePurge(session: SessionState, sessionKey: string, principal: string | undefined, rawArgs: Record<string, unknown>): Promise<object> {
  const params = rawArgs.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'force_creative_purge requires params',
    };
  }

  const creativeId = params.creative_id;
  if (typeof creativeId !== 'string' || creativeId.length === 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'creative_id is required',
    };
  }
  const creative = session.creatives.get(creativeId);
  if (!creative) {
    return {
      success: false,
      error: 'NOT_FOUND',
      current_state: null,
      error_detail: `Creative ${creativeId} not found`,
    };
  }

  const rawKind = params.purge_kind ?? 'soft';
  if (rawKind !== 'soft' && rawKind !== 'hard') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      current_state: creative.status,
      error_detail: "purge_kind must be 'soft' or 'hard'",
    };
  }
  const purgeKind = rawKind;
  const reasonCode = purgeReasonCode(purgeKind, params.reason_code);
  const reasonDetail = typeof params.reason_detail === 'string' ? params.reason_detail : undefined;
  const purgedAt = new Date().toISOString();
  const previousState = creative.purge ? 'purged' : creative.status;
  if (creative.purge) {
    return {
      success: true,
      previous_state: previousState,
      current_state: 'purged',
      message: `Creative ${creativeId} is already purged`,
    };
  }

  if (purgeKind === 'hard') {
    session.creatives.delete(creativeId);
    session.complyExtensions.provenanceAuditObservations.delete(creativeId);
  } else {
    creative.purge = {
      kind: 'soft',
      at: purgedAt,
      reasonCode,
    };
  }
  await emitCreativePurged(sessionKey, principal, creative, purgeKind, reasonCode, purgedAt, reasonDetail);

  return {
    success: true,
    previous_state: previousState,
    current_state: 'purged',
    purged: { creative_id: creativeId, purge_kind: purgeKind, purged_at: purgedAt, reason_code: reasonCode },
    message: `Creative ${creativeId} purged (${purgeKind})`,
  };
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

function handleQueryProvenanceAuditObservations(session: SessionState, rawArgs: Record<string, unknown>): object {
  const params = rawArgs.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'query_provenance_audit_observations requires params',
    };
  }

  const creativeId = params.creative_id;
  if (typeof creativeId !== 'string' || creativeId.length === 0) {
    return {
      success: false,
      error: 'INVALID_PARAMS',
      error_detail: 'creative_id is required',
    };
  }

  if (!session.creatives.has(creativeId)) {
    return {
      success: false,
      error: 'NOT_FOUND',
      error_detail: `Creative "${creativeId}" not found in this sandbox session`,
    };
  }

  return {
    success: true,
    creative_id: creativeId,
    audit_observations: session.complyExtensions.provenanceAuditObservations.get(creativeId) ?? [],
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
