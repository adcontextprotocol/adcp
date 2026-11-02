/**
 * Loader for the spec's reference model of reporting-subscription coverage
 * (`scripts/reference/reporting-coverage/`). The training agent computes the
 * periods a subscription owes with the same model the canonical vectors are
 * checked against, rather than a third implementation of the rule.
 *
 * The model is a CommonJS test oracle carrying a pinned IANA tzdata subset
 * (tzdata.json). It runs from server/src/training-agent during development
 * and tests, and from dist/training-agent in the built image, which copies
 * scripts/reference/reporting-coverage alongside dist.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CoverageModelRow {
  subscription_version: number;
  media_buy_id: string;
  offering_id: string;
  period_start: string;
  period_end: string;
  stub?: true;
}

export interface CoverageModelObligation {
  subscription_version: number;
  offering_id: string;
  period_start: string;
  period_end: string;
  stub?: true;
  media_buy_ids: string[];
}

export interface CoverageModelResult {
  expected: CoverageModelRow[];
  expected_obligations: CoverageModelObligation[];
  timezones: string[];
}

interface CoverageModel {
  expectedSubscriptionPeriods(input: Record<string, unknown>): CoverageModelResult;
  resolvePackage(pkg: unknown, version: unknown, offeringsById: Map<string, unknown>, at: number): string[];
  CoverageInputError: new (...args: never[]) => Error & { code: string; detail?: string };
}

interface CalendarModule {
  parseDuration(duration: string): { nominalMs: number };
  utcCalendar(duration: string): CalendarHandle;
  localCalendar(duration: string, zone: string): CalendarHandle;
}

export interface CalendarHandle {
  key: string;
  periods(lo: number, hi: number): Array<{ start: number; end: number }>;
}

interface TzModule {
  hasZone(name: string): boolean;
  isIanaName(name: string): boolean;
}

const MODEL_DIR = 'scripts/reference/reporting-coverage';

export function resolveCoverageModelDir(
  moduleUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
): string {
  const candidates = [
    fileURLToPath(new URL(`../../${MODEL_DIR}/`, moduleUrl)),
    fileURLToPath(new URL(`../../../${MODEL_DIR}/`, moduleUrl)),
  ];
  const root = candidates.find(candidate => pathExists(path.join(candidate, 'coverage.cjs')));
  if (!root) throw new Error(`Reporting coverage reference model is missing; checked ${candidates.join(', ')}`);
  return root;
}

let loaded: { model: CoverageModel; calendar: CalendarModule; tz: TzModule } | undefined;

function load() {
  if (!loaded) {
    const dir = resolveCoverageModelDir();
    const require = createRequire(path.join(dir, 'coverage.cjs'));
    loaded = {
      model: require('./coverage.cjs') as CoverageModel,
      calendar: require('./calendar.cjs') as CalendarModule,
      tz: require('./tz.cjs') as TzModule,
    };
  }
  return loaded;
}

/** Owed periods for one subscription and account, from the reference model. */
export function expectedSubscriptionPeriods(input: Record<string, unknown>): CoverageModelResult {
  return load().model.expectedSubscriptionPeriods(input);
}

/** Offerings one package resolves to under a version at an instant: the
 * model's own selection rule (`selector.match`, finality, method, timezone). */
export function resolvePackageWithModel(
  pkg: { package_id: string; reporting_delivery_offering_ids: string[] },
  version: { config: Record<string, unknown>; destinationMethod?: { pattern: string; transport: string } },
  offeringsById: Map<string, unknown>,
  at: number,
): string[] {
  return load().model.resolvePackage(pkg, version, offeringsById, at);
}

export function isCoverageInputError(error: unknown): error is Error & { code: string; detail?: string } {
  return error instanceof load().model.CoverageInputError;
}

/** Whether the model's pinned tzdata carries the zone. */
export function coverageModelHasZone(zone: string): boolean {
  const { tz } = load();
  return zone === 'UTC' || zone === 'Etc/UTC' || (tz.isIanaName(zone) && tz.hasZone(zone));
}

/** A calendar for an offering schedule in one zone (utc or local alignment). */
export function scheduleCalendar(duration: string, alignment: 'utc' | 'local', zone?: string): CalendarHandle {
  const { calendar } = load();
  return alignment === 'utc' ? calendar.utcCalendar(duration) : calendar.localCalendar(duration, zone ?? 'UTC');
}
