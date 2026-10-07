/**
 * Budget periods on campaign governance plans (`plans[].budget.periods[]`).
 *
 * A period is a half-open `[start, end)` window with its own `amount`. The
 * plan's dated commitments are bucketed by the period that contains the whole
 * flight of the buy that carries them; undated commitments never enter a
 * period. Pure functions only: handlers own session state and findings.
 * Spec: docs/governance/campaign/specification.mdx §"Budget periods".
 */

import type {
  GovernanceActionFlight,
  GovernanceAdjustmentState,
  GovernanceBudgetPeriod,
  GovernanceOutcomeState,
} from './types.js';

const AMOUNT_EPSILON = 1e-6;
export const PERIOD_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Periods are bounded so every check stays cheap; a daily split of a year fits. */
export const MAX_BUDGET_PERIODS = 366;
const PERIOD_KEYS = new Set(['budget_period_id', 'start', 'end', 'amount']);

const overBound = (total: number, bound: number): boolean => total > bound + AMOUNT_EPSILON;

/**
 * Strict RFC 3339 date-time. `Date.parse` alone rolls 30 February to March and
 * hour 24 to the next day, so a calendar-exact parser elsewhere would place the
 * same flight in a different period.
 */
export function parseDateTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DATE_TIME_RE.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(i => Number(match[i] ?? 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

const periodBoundsCache = new WeakMap<GovernanceBudgetPeriod, { start: number; end: number }>();
function periodBounds(period: GovernanceBudgetPeriod): { start: number; end: number } {
  let bounds = periodBoundsCache.get(period);
  if (!bounds) {
    bounds = { start: Date.parse(period.start), end: Date.parse(period.end) };
    periodBoundsCache.set(period, bounds);
  }
  return bounds;
}

export interface BudgetPeriodValidationError {
  message: string;
  field: string;
}

/**
 * Validate and normalize `budget.periods[]` for a plan. Returns the periods
 * sorted by start, or the first violation of the schema-level or cross-field
 * rules: ids unique, `start` < `end`, inside the plan flight, no overlap,
 * amounts sum to at most `budget.total`.
 */
export function parseBudgetPeriods(
  raw: unknown,
  plan: { planId: string; flight: GovernanceActionFlight; total: number },
): { periods: GovernanceBudgetPeriod[] } | { error: BudgetPeriodValidationError } {
  const base = `plan ${plan.planId} budget.periods`;
  const fail = (message: string, field: string) => ({ error: { message: `${base}${message}`, field } });
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(' must be a non-empty array when present', 'budget.periods');
  }
  if (raw.length > MAX_BUDGET_PERIODS) {
    return fail(` has ${raw.length} entries; at most ${MAX_BUDGET_PERIODS} are allowed`, 'budget.periods');
  }
  const flightStart = parseDateTime(plan.flight.start);
  const flightEnd = parseDateTime(plan.flight.end);
  if (flightStart === undefined || flightEnd === undefined) {
    return fail(' require the plan flight to carry ISO 8601 start and end', 'flight');
  }
  const seen = new Set<string>();
  const periods: Array<GovernanceBudgetPeriod & { startMs: number; endMs: number }> = [];
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    const at = `budget.periods[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`[${i}] must be an object`, at);
    }
    const unknownKey = Object.keys(entry).find(key => !PERIOD_KEYS.has(key));
    if (unknownKey) return fail(`[${i}] has unsupported property ${unknownKey}`, `${at}.${unknownKey}`);
    const id = entry.budget_period_id;
    if (typeof id !== 'string' || !PERIOD_ID_RE.test(id)) {
      return fail(`[${i}].budget_period_id must match ${PERIOD_ID_RE.source}`, `${at}.budget_period_id`);
    }
    if (seen.has(id)) return fail(`[${i}].budget_period_id ${id} is not unique within the plan`, `${at}.budget_period_id`);
    seen.add(id);
    const startMs = parseDateTime(entry.start);
    const endMs = parseDateTime(entry.end);
    if (startMs === undefined) return fail(`[${i}].start must be an ISO 8601 date-time`, `${at}.start`);
    if (endMs === undefined) return fail(`[${i}].end must be an ISO 8601 date-time`, `${at}.end`);
    if (endMs <= startMs) return fail(`[${i}] (${id}) end must be later than start`, `${at}.end`);
    if (startMs < flightStart || endMs > flightEnd) {
      return fail(`[${i}] (${id}) must sit inside the plan flight ${plan.flight.start} to ${plan.flight.end}`, at);
    }
    const amount = entry.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return fail(`[${i}].amount must be a finite number >= 0`, `${at}.amount`);
    }
    sum += amount;
    periods.push({
      budgetPeriodId: id,
      start: entry.start as string,
      end: entry.end as string,
      amount,
      startMs,
      endMs,
    });
  }
  periods.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].startMs < periods[i - 1].endMs) {
      return fail(
        ` periods ${periods[i - 1].budgetPeriodId} and ${periods[i].budgetPeriodId} overlap; adjacent periods may share a boundary but not overlap`,
        'budget.periods',
      );
    }
  }
  if (overBound(sum, plan.total)) {
    return fail(` amounts sum to ${sum}, above budget.total ${plan.total}`, 'budget.periods');
  }
  return { periods: periods.map(({ startMs: _s, endMs: _e, ...period }) => period) };
}

export type ActionFlightResolution =
  | { kind: 'undated' }
  | { kind: 'dated'; flight: GovernanceActionFlight }
  | { kind: 'invalid'; reason: string };

/**
 * Resolve the flight an action carries. `asap` start means the evaluation
 * time. A side the action does not state falls back to the flight already on
 * the ledger for the buy being modified. An action that states neither side
 * and has no ledger flight is undated; an action that states only one side
 * and cannot complete it is invalid rather than silently undated.
 */
export function resolveActionFlight(
  stated: { start?: unknown; end?: unknown; conflict?: string },
  fallback: GovernanceActionFlight | undefined,
  nowMs: number,
): ActionFlightResolution {
  const resolveSide = (value: unknown, side: 'start' | 'end'): string | undefined | null => {
    if (value === undefined || value === null) return undefined;
    if (value === 'asap' && side === 'start') return new Date(nowMs).toISOString();
    return parseDateTime(value) === undefined ? null : (value as string);
  };
  if (stated.conflict) return { kind: 'invalid', reason: stated.conflict };
  const start = resolveSide(stated.start, 'start');
  const end = resolveSide(stated.end, 'end');
  if (start === null) return { kind: 'invalid', reason: `start ${String(stated.start)} is not an ISO 8601 date-time or asap` };
  if (end === null) return { kind: 'invalid', reason: `end ${String(stated.end)} is not an ISO 8601 date-time` };
  if (start === undefined && end === undefined && !fallback) return { kind: 'undated' };
  const resolvedStart = start ?? fallback?.start;
  const resolvedEnd = end ?? fallback?.end;
  if (resolvedStart === undefined || resolvedEnd === undefined) {
    return { kind: 'invalid', reason: 'the flight states only one of start and end and no prior flight is on the ledger' };
  }
  if (Date.parse(resolvedEnd) < Date.parse(resolvedStart)) {
    return { kind: 'invalid', reason: 'end is earlier than start' };
  }
  return { kind: 'dated', flight: { start: resolvedStart, end: resolvedEnd } };
}

/**
 * Merge the places an action can state its flight (the task's own top-level
 * `start_time`/`end_time`, a `flight` object, campaign dates). Per side, every
 * stated value must agree; a payload that states two different flights is
 * ambiguous and must not be placed by whichever one the governance agent
 * happened to read, because the service executes the task's own fields.
 */
export function mergeStatedFlight(
  candidates: Array<{ start?: unknown; end?: unknown } | undefined>,
): { start?: unknown; end?: unknown; conflict?: string } {
  const merged: { start?: unknown; end?: unknown } = {};
  for (const side of ['start', 'end'] as const) {
    for (const candidate of candidates) {
      const value = candidate?.[side];
      if (value === undefined || value === null) continue;
      if (merged[side] === undefined) {
        merged[side] = value;
        continue;
      }
      const same = merged[side] === value
        || (parseDateTime(merged[side]) !== undefined && parseDateTime(merged[side]) === parseDateTime(value));
      if (!same) return { conflict: `the payload states conflicting flight ${side} values ${String(merged[side])} and ${String(value)}` };
    }
  }
  return merged;
}

export type PeriodMatch =
  | { kind: 'contained'; period: GovernanceBudgetPeriod }
  | { kind: 'straddles'; periods: GovernanceBudgetPeriod[] }
  | { kind: 'unallocated' };

/**
 * Find the period that contains a flight's whole `[start, end)` window. A
 * flight touching two or more periods straddles; one not fully inside any
 * single period (a gap, or past the last period) is unallocated. A zero-length
 * flight is an instant, and the boundary instant belongs to the later period.
 */
export function matchBudgetPeriod(periods: GovernanceBudgetPeriod[], flight: GovernanceActionFlight): PeriodMatch {
  const start = Date.parse(flight.start);
  const end = Date.parse(flight.end);
  const instant = end === start;
  const contained = periods.find(period => {
    const bounds = periodBounds(period);
    return start >= bounds.start && (instant ? start < bounds.end : end <= bounds.end);
  });
  if (contained) return { kind: 'contained', period: contained };
  const touched = periods.filter(period =>
    periodBounds(period).start < (instant ? start + 1 : end) && start < periodBounds(period).end);
  return touched.length > 1 ? { kind: 'straddles', periods: touched } : { kind: 'unallocated' };
}

export interface BuyCommitment {
  key: string;
  /** Net of adjustments that restored headroom. */
  amount: number;
  /** Flight of the buy's latest settled action; absent when it never carried dates. */
  flight?: GovernanceActionFlight;
}

/**
 * Aggregate settled commitments per buy. A buy is its `media_buy_id`: the id
 * a modification or execution check bound, else the `seller_reference` the
 * creating outcome reported (the media_buy_id for a media buy). An outcome
 * with neither is its own buy. The buy's flight is the latest
 * flight any of its outcomes carried, which is what lets a modification move
 * the buy's whole commitment to another period.
 */
export function buildBuyCommitments(
  outcomes: Iterable<GovernanceOutcomeState>,
  adjustments: Iterable<GovernanceAdjustmentState>,
): Map<string, BuyCommitment> {
  const restoredByOutcome = new Map<string, number>();
  for (const adjustment of adjustments) {
    restoredByOutcome.set(
      adjustment.outcomeId,
      (restoredByOutcome.get(adjustment.outcomeId) ?? 0) + adjustment.headroomRestored,
    );
  }
  const buys = new Map<string, BuyCommitment & { flightAt?: string }>();
  for (const outcome of outcomes) {
    if (outcome.outcomeType !== 'completed') continue;
    const key = outcome.mediaBuyId ?? outcome.sellerReference ?? outcome.outcomeId;
    const buy = buys.get(key) ?? { key, amount: 0 };
    buy.amount += outcome.committedBudget - (restoredByOutcome.get(outcome.outcomeId) ?? 0);
    if (outcome.flight && (buy.flightAt === undefined || outcome.timestamp >= buy.flightAt)) {
      buy.flight = outcome.flight;
      buy.flightAt = outcome.timestamp;
    }
    buys.set(key, buy);
  }
  return new Map([...buys].map(([key, { flightAt: _at, ...buy }]) => [key, buy]));
}

/** Committed amount per period id, plus buys whose flight sits in no single period. */
export function periodUsage(
  periods: GovernanceBudgetPeriod[],
  buys: Iterable<BuyCommitment>,
  excludeKey?: string,
): { byPeriod: Map<string, number>; orphans: BuyCommitment[] } {
  const byPeriod = new Map<string, number>();
  const orphans: BuyCommitment[] = [];
  for (const buy of buys) {
    if (buy.key === excludeKey || !buy.flight || buy.amount <= 0) continue;
    const match = matchBudgetPeriod(periods, buy.flight);
    if (match.kind === 'contained') {
      const id = match.period.budgetPeriodId;
      byPeriod.set(id, (byPeriod.get(id) ?? 0) + buy.amount);
    } else {
      orphans.push(buy);
    }
  }
  return { byPeriod, orphans };
}

/**
 * Rule 6: a re-sync must not leave an existing dated commitment outside every
 * period, nor set a period's `amount` below what is already committed to it.
 */
export function periodResyncViolation(
  planId: string,
  periods: GovernanceBudgetPeriod[],
  buys: Iterable<BuyCommitment>,
): { message: string; field: string } | undefined {
  const { byPeriod, orphans } = periodUsage(periods, buys);
  if (orphans.length > 0) {
    const orphan = orphans[0];
    return {
      message: `plan ${planId} budget.periods would leave the commitment of ${orphan.key} ($${orphan.amount}, flight ${orphan.flight!.start} to ${orphan.flight!.end}) outside every period`,
      field: 'budget.periods',
    };
  }
  for (const [index, period] of periods.entries()) {
    const committed = byPeriod.get(period.budgetPeriodId) ?? 0;
    if (overBound(committed, period.amount)) {
      return {
        message: `plan ${planId} budget.periods ${period.budgetPeriodId} amount ${period.amount} is below the $${committed} already committed to it`,
        field: `budget.periods[${index}].amount`,
      };
    }
  }
  return undefined;
}

export interface PeriodFinding {
  explanation: string;
  details?: { field: string; expected?: unknown; actual?: unknown };
}

export interface PeriodCheckResult {
  /** Derived period; set whenever a single period contains the flight. */
  periodId?: string;
  findings: PeriodFinding[];
}

/**
 * Rules 3-5 for one dated action. `amount` is the incremental commitment the
 * action would add; `buyKey` names the buy it modifies, whose whole existing
 * commitment moves with it (rule 4) rather than staying in the old period.
 * Every finding is critical: periods deny, they do not counter-propose.
 */
export function evaluateBudgetPeriods(input: {
  periods: GovernanceBudgetPeriod[] | undefined;
  flight: GovernanceActionFlight | undefined;
  amount: number | undefined;
  buyKey?: string;
  buys: Map<string, BuyCommitment>;
  asserted?: string;
  /** Derive the period for the response without denying (delivery checks). */
  deriveOnly?: boolean;
}): PeriodCheckResult {
  const { periods, flight, asserted } = input;
  const findings: PeriodFinding[] = [];
  const unmatchedAssertion = (why: string) => {
    if (asserted !== undefined && !input.deriveOnly) {
      findings.push({
        explanation: `budget_period_id ${asserted} was asserted but ${why}, so no period can match it.`,
        details: { field: 'budget_period_id', actual: asserted },
      });
    }
    return { findings };
  };
  if (!periods?.length) return unmatchedAssertion('the plan has no budget periods');
  if (!flight) return unmatchedAssertion('the action carries no flight dates');

  const match = matchBudgetPeriod(periods, flight);
  if (match.kind !== 'contained') {
    if (!input.deriveOnly) {
      findings.push({
        explanation: match.kind === 'straddles'
          ? `Flight ${flight.start} to ${flight.end} straddles budget periods ${match.periods.map(p => p.budgetPeriodId).join(' and ')}; split it into one buy per period.`
          : `Flight ${flight.start} to ${flight.end} is not inside any single budget period; unallocated budget cannot be committed to a dated action until it is assigned to a period.`,
      });
    }
    return { findings };
  }

  const period = match.period;
  const periodId = period.budgetPeriodId;
  if (input.deriveOnly) return { periodId, findings };
  if (asserted !== undefined && asserted !== periodId) {
    findings.push({
      explanation: `Asserted budget_period_id ${asserted} does not match the period ${periodId} that contains the flight.`,
      details: { field: 'budget_period_id', expected: periodId, actual: asserted },
    });
  }
  if (input.amount !== undefined) {
    const used = periodUsage(periods, input.buys.values(), input.buyKey).byPeriod.get(periodId) ?? 0;
    const carried = input.buyKey ? Math.max(input.buys.get(input.buyKey)?.amount ?? 0, 0) : 0;
    const required = used + carried + input.amount;
    if (overBound(required, period.amount)) {
      findings.push({
        explanation: `Commitment of $${input.amount}${carried > 0 ? ` plus the buy's existing $${carried}` : ''} would take period ${periodId} to $${required}, over its $${period.amount} (already committed to the period: $${used}).`,
        details: { field: 'budget.periods.amount', expected: period.amount - used - carried, actual: input.amount },
      });
    }
  }
  return { periodId, findings };
}
