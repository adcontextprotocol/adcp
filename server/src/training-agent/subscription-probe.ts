/**
 * `reporting_subscription_probe` controller scenario (experimental,
 * `media_buy.reporting_subscriptions`, AdCP 3.3).
 *
 * Drives the inputs reporting-subscription coverage depends on that a buyer
 * cannot change itself: the caller's grant on a sandbox account, the
 * account's timezone, and the caller's sandbox clock. Every operation acts
 * only on the authenticated caller's own sandbox accounts and grants, and is
 * convergent: repeating it at the same `simulated_now` returns the same
 * result.
 */
import {
  callerAccountAttributes,
  findCallerAccount,
  updateCallerAccount,
} from './account-handlers.js';
import {
  grantFor,
  isIanaTimezone,
  loadSandbox,
  recordTimezoneChange,
  reduceGrant,
  regrantGrant,
  revokeGrant,
  sandboxNowIso,
  sandboxNowMs,
  timezoneChangesFor,
  type SandboxDocument,
} from './account-sandbox.js';
import { advanceAccountRequestsForCaller } from './account-requests.js';
import type { TrainingContext } from './types.js';

type Json = Record<string, unknown>;

export const REPORTING_SUBSCRIPTION_PROBE = 'reporting_subscription_probe';

const OPERATIONS = ['revoke_grant', 'regrant', 'reduce_grant', 'set_account_timezone', 'advance_time'] as const;
type Operation = typeof OPERATIONS[number];

/** Per-offering cutover instants for an account timezone change, supplied by
 * the reporting-subscription layer (the offerings whose periods follow the
 * account timezone). */
export type TimezoneCutoverResolver = (
  previousTimezone: string,
  timezone: string,
  atMs: number,
) => Array<{ offering_id: string; effective_at: string }>;

let timezoneCutoverResolver: TimezoneCutoverResolver = () => [];

export function setTimezoneCutoverResolver(resolver: TimezoneCutoverResolver): void {
  timezoneCutoverResolver = resolver;
}

/** Hook run after `advance_time` moves the clock, so seller-side work due by
 * the new instant happens then (account request reviews, subscription
 * obligations). */
type AdvanceHook = (ctx: TrainingContext, nowMs: number) => Promise<void>;
const advanceHooks: AdvanceHook[] = [async ctx => advanceAccountRequestsForCaller(ctx)];

export function onSandboxClockAdvanced(hook: AdvanceHook): void {
  advanceHooks.push(hook);
}

function failure(error: string, detail: string): Json {
  return { success: false, error, error_detail: detail };
}

function success(doc: SandboxDocument, simulated: Json, message: string): Json {
  return {
    success: true,
    simulated: { simulated_now: sandboxNowIso(doc), ...simulated },
    message,
  };
}

function isTaskName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) && value.length <= 128;
}

export async function handleReportingSubscriptionProbe(
  params: Json,
  ctx: TrainingContext,
): Promise<Json> {
  const operation = params.operation as Operation;
  if (!OPERATIONS.includes(operation)) {
    return failure('INVALID_PARAMS', `operation must be one of ${OPERATIONS.join(', ')}`);
  }
  const sandbox = await loadSandbox(ctx.principal);
  const doc = sandbox.doc;

  if (operation === 'advance_time') {
    const target = typeof params.target_time === 'string' ? Date.parse(params.target_time) : Number.NaN;
    if (!Number.isFinite(target)) return failure('INVALID_PARAMS', 'target_time must be an RFC 3339 date-time');
    const now = sandboxNowMs(doc);
    if (target <= now) {
      return failure('INVALID_PARAMS', `target_time must be after the current simulated_now (${new Date(now).toISOString()})`);
    }
    doc.simulated_now = new Date(target).toISOString();
    sandbox.save();
    for (const hook of advanceHooks) await hook(ctx, target);
    return success(doc, {}, `Sandbox clock advanced to ${doc.simulated_now}`);
  }

  const accountId = params.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return failure('INVALID_PARAMS', 'account_id is required');
  }
  // The probe reaches a revoked account too: regrant must be able to restore it.
  const account = await findCallerAccount(ctx, accountId);
  if (!account) return failure('NOT_FOUND', `Account ${accountId} is not one of your accounts`);
  if (account.sandbox !== true) return failure('FORBIDDEN', 'reporting_subscription_probe acts only on sandbox accounts');
  const nowIso = sandboxNowIso(doc);

  if (operation === 'revoke_grant') {
    const grant = revokeGrant(doc, accountId, nowIso);
    sandbox.save();
    return success(doc, { account_id: accountId, unauthorized_at: grant.unauthorized_at }, `Grant on ${accountId} revoked`);
  }

  if (operation === 'regrant') {
    const { grant, chain } = regrantGrant(doc, accountId, nowIso);
    sandbox.save();
    return success(doc, {
      account_id: accountId,
      authorized_at: grant.authorized_at,
      chain,
      ...(chain === 'continued' && grant.regranted_at && { regranted_at: grant.regranted_at }),
    }, `Grant on ${accountId} restored (${chain} chain)`);
  }

  if (operation === 'reduce_grant') {
    const tasks = params.allowed_tasks;
    if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every(isTaskName)) {
      return failure('INVALID_PARAMS', 'allowed_tasks must be a non-empty array of task names');
    }
    if (grantFor(doc, accountId)?.unauthorized_at) {
      return failure('INVALID_STATE', 'The grant is revoked; regrant before reducing it');
    }
    const grant = reduceGrant(doc, accountId, tasks, nowIso);
    sandbox.save();
    return success(doc, { account_id: accountId, allowed_tasks: grant.allowed_tasks }, `Grant on ${accountId} reduced`);
  }

  // set_account_timezone
  const timezone = params.timezone;
  if (!isIanaTimezone(timezone)) return failure('INVALID_PARAMS', 'timezone must be an IANA timezone name');
  if (grantFor(doc, accountId)?.unauthorized_at) {
    return failure('INVALID_STATE', 'The grant is revoked; regrant before changing the account');
  }
  const previous = callerAccountAttributes(account).timezone ?? 'UTC';
  const changes = timezoneChangesFor(doc, accountId);
  const last = changes[changes.length - 1];
  if (previous === timezone) {
    // Convergent: a repeat at the same instant reports the change it made.
    const repeated = last && last.timezone === timezone && last.at === nowIso ? last : undefined;
    return success(doc, {
      account_id: accountId,
      previous_timezone: repeated?.previous_timezone ?? previous,
      timezone,
      timezone_cutovers: repeated
        ? timezoneCutoverResolver(repeated.previous_timezone, timezone, Date.parse(nowIso))
        : [],
    }, `Account ${accountId} already uses ${timezone}`);
  }
  await updateCallerAccount(ctx, accountId, { timezone }, {
    summary: 'Account timezone changed by the sandbox controller.',
  });
  recordTimezoneChange(doc, accountId, { at: nowIso, previous_timezone: previous, timezone });
  sandbox.save();
  return success(doc, {
    account_id: accountId,
    previous_timezone: previous,
    timezone,
    timezone_cutovers: timezoneCutoverResolver(previous, timezone, Date.parse(nowIso)),
  }, `Account ${accountId} timezone changed from ${previous} to ${timezone}`);
}
