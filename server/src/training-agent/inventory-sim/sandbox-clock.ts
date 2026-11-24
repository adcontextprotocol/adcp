/**
 * The `sandbox_clock` controller scenario (#9025 part A), served by the
 * inventory tenants:
 *
 *   { "scenario": "sandbox_clock", "params": { "operation": "get" } }
 *   { "scenario": "sandbox_clock", "params": { "operation": "advance_time", "to": "2027-01-15T00:00:00Z" } }
 *   { "scenario": "sandbox_clock", "params": { "operation": "advance_time", "by": "P30D" } }
 *
 * It moves the caller's one sandbox clock (`simulated_now` in
 * `account-sandbox.ts`), the same clock `reporting_subscription_probe`
 * `advance_time` moves. It only moves forward and `reset_state` unpins it.
 * Advancing runs the day steps for each day crossed in the market of the
 * tenant it is called on; the caller's other markets run the same days on
 * their next read, with the same results. Writing only that tenant's market
 * keeps the write under the router's lock for that tenant. Both operations
 * report `seed_id`, `season_fingerprint` and `engine_version` inside
 * `simulated`, which the response schema leaves open, so a run records which
 * season and engine produced its results.
 */
import { loadSandbox, sandboxNowIso, sandboxNowMs } from '../account-sandbox.js';
import { runSandboxClockAdvanceHooks } from '../subscription-probe.js';
import type { TrainingContext } from '../types.js';
import { DAY_MS, ENGINE_VERSION, type SeasonSeed } from './engine/index.js';
import { advanceMarket } from './market-store.js';
import { seasonFingerprint } from './season-file.js';

export const SANDBOX_CLOCK_SCENARIO = 'sandbox_clock';

type Json = Record<string, unknown>;

const DURATION_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
/** Ten years: far past any season, short of overflowing a Date. */
const MAX_ADVANCE_MS = 10 * 366 * 24 * 60 * 60 * 1000;

/** An ISO 8601 duration in weeks, days, hours, minutes and seconds, in
 * milliseconds. Months and years are refused: their length depends on the
 * date. */
export function parseDuration(value: string): number | undefined {
  const match = DURATION_RE.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) return undefined;
  const [weeks, days, hours, minutes, seconds] = match.slice(1).map(part => (part ? Number(part) : 0));
  return ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function failure(error: string, detail: string): Json {
  return { success: false, error, error_detail: detail };
}

export async function handleSandboxClock(
  params: Json,
  ctx: TrainingContext,
  market: { tenantId: string; seed: SeasonSeed },
): Promise<Json> {
  const operation = params.operation;
  const provenance = { seed_id: market.seed.seed_id, season_fingerprint: seasonFingerprint(market.seed), engine_version: ENGINE_VERSION };
  const sandbox = await loadSandbox(ctx.principal);
  const nowMs = sandboxNowMs(sandbox.doc);
  if (operation === 'get') {
    return {
      success: true,
      simulated: { simulated_now: sandboxNowIso(sandbox.doc), pinned: sandbox.doc.simulated_now !== undefined, ...provenance },
      message: `simulated_now is ${sandboxNowIso(sandbox.doc)}`,
    };
  }
  if (operation !== 'advance_time') {
    return failure('INVALID_PARAMS', 'sandbox_clock requires params.operation: get or advance_time');
  }
  const hasTo = params.to !== undefined;
  const hasBy = params.by !== undefined;
  if (hasTo === hasBy) return failure('INVALID_PARAMS', 'advance_time takes exactly one of params.to (an RFC 3339 date-time) or params.by (an ISO 8601 duration)');
  let target: number;
  if (hasTo) {
    target = typeof params.to === 'string' ? Date.parse(params.to) : Number.NaN;
    if (!Number.isFinite(target)) return failure('INVALID_PARAMS', 'params.to must be an RFC 3339 date-time');
  } else {
    const duration = typeof params.by === 'string' ? parseDuration(params.by) : undefined;
    if (duration === undefined) return failure('INVALID_PARAMS', 'params.by must be an ISO 8601 duration in weeks, days, hours, minutes or seconds, such as P30D or PT6H');
    target = nowMs + duration;
  }
  if (target <= nowMs) {
    return failure('INVALID_TRANSITION', `The sandbox clock only moves forward; simulated_now is ${new Date(nowMs).toISOString()}`);
  }
  if (target - nowMs > MAX_ADVANCE_MS) return failure('INVALID_PARAMS', 'advance_time moves the clock at most ten years at a time');
  sandbox.doc.simulated_now = new Date(target).toISOString();
  sandbox.save();
  await advanceMarket(market.tenantId, market.seed, ctx.principal);
  const daysCrossed = Math.floor(target / DAY_MS) - Math.floor(nowMs / DAY_MS);
  await runSandboxClockAdvanceHooks(ctx, target);
  return {
    success: true,
    simulated: { simulated_now: sandbox.doc.simulated_now, previous_simulated_now: new Date(nowMs).toISOString(), days_crossed: daysCrossed, ...provenance },
    message: `Sandbox clock advanced to ${sandbox.doc.simulated_now}`,
  };
}
