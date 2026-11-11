/**
 * AdCP 4.0 readiness report (adcp#8332).
 *
 * `static/compliance/source/universal/v4-compatibility.yaml` lists the checks
 * that tell a 3.x agent what AdCP 4.0 removes or tightens. Its header defines
 * how one compliance run grades each check as passed, failing, or not
 * observable. This module applies that rule to the runner output we have in
 * memory at ingest and returns a compact per-check report for the run row.
 *
 * The registry is the only source of check ids and text: nothing here names a
 * check. The report is advisory and never feeds 3.x verification.
 *
 * Grading uses structured runner output only, never diagnostic prose:
 *   - A validation-observed check passes only when the runner reports a
 *     validation result carrying the check id that passed and was graded
 *     (not `not_applicable`). It fails when a result with that id failed.
 *   - A notice-observed check fails when the run emitted a notice with the
 *     check id. Absence is "not observable": canonical notices are
 *     SHOULD-emit, and this module does not assume which codes a runner emits.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { type ComplianceResult } from '@adcp/sdk/testing';
import { getCachedComplianceStoryboardById } from './storyboard-cache.js';
import { hostedComplianceOptions, hostedComplianceTarget } from '../services/hosted-compliance-version.js';
import { createLogger } from '../logger.js';

const logger = createLogger('v4-readiness');

const DOCS_SITE_ORIGIN = 'https://adcontextprotocol.org';
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export type V4CheckStatus = 'passed' | 'failing' | 'not_observable';

export type V4NotObservableReason =
  /** None of the storyboards that grade the check ran. */
  | 'storyboard_not_run'
  /** The storyboard ran but none of the grading steps did. */
  | 'step_not_run'
  /** Every grading step that appeared was skipped. */
  | 'step_skipped'
  /** A grading step ran but reported no graded result for the check id. */
  | 'not_graded'
  /** The storyboard ran without the notice; absence proves nothing. */
  | 'notice_absent'
  /** The registry declares the check unobservable on a 3.x agent. */
  | 'not_observed_by_suite';

export interface V4CompatibilityCheck {
  id: string;
  issue?: number;
  change?: string;
  applies_to?: string[];
  detection: string;
  fix: string;
  observed_by: {
    validation?: { storyboard: string; steps: string[] };
    notice?: { storyboards: string[] };
    none?: { reason?: string };
  };
}

export interface V4CompatibilityRegistry {
  version: string;
  target_version: string;
  migration_guide?: string;
  checks: V4CompatibilityCheck[];
}

/** Runner evidence for one storyboard step, keyed by storyboard and step id. */
export interface V4StepEvidence {
  storyboard_id: string;
  step_id: string;
  skipped: boolean;
  /** Validation results with authored ids, when the runner reports them per step. */
  validations?: Array<{ id?: string; passed?: boolean; not_applicable?: boolean }>;
  /** Validation ids the runner reported as failed on this step. */
  failed_validation_ids?: string[];
}

export interface V4ReadinessEvidence {
  storyboards_run: string[];
  steps: V4StepEvidence[];
  notice_codes: string[];
}

export interface V4ReadinessCheckResult {
  id: string;
  status: V4CheckStatus;
  reason: V4NotObservableReason | null;
  issue: number | null;
  change: string | null;
  detection: string;
  fix: string;
  guide_url: string | null;
}

export interface V4ReadinessReport {
  registry_version: string;
  target_version: string;
  checks: V4ReadinessCheckResult[];
}

function guideUrl(registry: V4CompatibilityRegistry, checkId: string): string | null {
  const guide = registry.migration_guide;
  if (typeof guide !== 'string' || !guide.startsWith('docs/') || !guide.endsWith('.mdx')) return null;
  return `${DOCS_SITE_ORIGIN}/${guide.slice(0, -'.mdx'.length)}#${encodeURIComponent(checkId)}`;
}

function gradeCheck(
  check: V4CompatibilityCheck,
  evidence: V4ReadinessEvidence,
  storyboardsRun: ReadonlySet<string>,
  noticeCodes: ReadonlySet<string>,
): { status: V4CheckStatus; reason: V4NotObservableReason | null } {
  const { validation, notice } = check.observed_by ?? {};

  if (validation) {
    if (!storyboardsRun.has(validation.storyboard)) {
      return { status: 'not_observable', reason: 'storyboard_not_run' };
    }
    const steps = evidence.steps.filter(step =>
      step.storyboard_id === validation.storyboard && validation.steps.includes(step.step_id));
    if (steps.length === 0) return { status: 'not_observable', reason: 'step_not_run' };
    const graded = steps.filter(step => !step.skipped);
    if (graded.length === 0) return { status: 'not_observable', reason: 'step_skipped' };

    const failed = graded.some(step =>
      step.failed_validation_ids?.includes(check.id)
      || step.validations?.some(v => v.id === check.id && v.passed === false));
    if (failed) return { status: 'failing', reason: null };

    const passed = graded.some(step =>
      step.validations?.some(v => v.id === check.id && v.passed === true && v.not_applicable !== true));
    if (passed) return { status: 'passed', reason: null };
    return { status: 'not_observable', reason: 'not_graded' };
  }

  if (notice) {
    if (noticeCodes.has(check.id)) return { status: 'failing', reason: null };
    const ran = notice.storyboards.some(id => storyboardsRun.has(id));
    return { status: 'not_observable', reason: ran ? 'notice_absent' : 'storyboard_not_run' };
  }

  return { status: 'not_observable', reason: 'not_observed_by_suite' };
}

/**
 * Grade every registry check against one run's evidence. Pure: the caller
 * supplies the registry and the evidence.
 */
export function deriveV4ReadinessReport(
  registry: V4CompatibilityRegistry,
  evidence: V4ReadinessEvidence,
): V4ReadinessReport {
  const storyboardsRun = new Set(evidence.storyboards_run);
  const noticeCodes = new Set(evidence.notice_codes);
  return {
    registry_version: registry.version,
    target_version: registry.target_version,
    checks: registry.checks.map(check => {
      const { status, reason } = gradeCheck(check, evidence, storyboardsRun, noticeCodes);
      return {
        id: check.id,
        status,
        reason,
        issue: typeof check.issue === 'number' ? check.issue : null,
        change: typeof check.change === 'string' ? check.change : null,
        detection: check.detection,
        fix: check.fix,
        guide_url: guideUrl(registry, check.id),
      };
    }),
  };
}

// ── Registry loading ────────────────────────────────────────────────

const registryCache = new Map<string, V4CompatibilityRegistry | null>();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isCheck(value: unknown): value is V4CompatibilityCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as Record<string, unknown>;
  if (typeof check.id !== 'string' || typeof check.detection !== 'string' || typeof check.fix !== 'string') {
    return false;
  }
  const observedBy = check.observed_by as Record<string, unknown> | undefined;
  if (!observedBy || typeof observedBy !== 'object') return false;
  const validation = observedBy.validation as Record<string, unknown> | undefined;
  const notice = observedBy.notice as Record<string, unknown> | undefined;
  if (validation && (typeof validation.storyboard !== 'string' || !isStringArray(validation.steps))) return false;
  if (notice && !isStringArray(notice.storyboards)) return false;
  return true;
}

function parseRegistry(text: string): V4CompatibilityRegistry | null {
  const parsed = YAML.parse(text) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.version !== 'string' || typeof parsed.target_version !== 'string') return null;
  if (!Array.isArray(parsed.checks) || !parsed.checks.every(isCheck)) return null;
  return {
    version: parsed.version,
    target_version: parsed.target_version,
    migration_guide: typeof parsed.migration_guide === 'string' ? parsed.migration_guide : undefined,
    checks: parsed.checks,
  };
}

/**
 * Load the registry shipped with the run's compliance bundle, or the working
 * registry in `static/compliance/source` when that bundle predates it. Steps
 * the run's bundle does not grade still come out not observable, because the
 * evidence comes from the run itself.
 */
export function loadV4CompatibilityRegistry(adcpVersion?: string | null): V4CompatibilityRegistry | null {
  const candidates = [
    ...(adcpVersion && EXACT_VERSION_RE.test(adcpVersion)
      ? [resolve(process.cwd(), 'dist', 'compliance', adcpVersion, 'universal', 'v4-compatibility.yaml')]
      : []),
    resolve(process.cwd(), 'static', 'compliance', 'source', 'universal', 'v4-compatibility.yaml'),
  ];
  for (const path of candidates) {
    if (registryCache.has(path)) {
      const cached = registryCache.get(path);
      if (cached) return cached;
      continue;
    }
    let registry: V4CompatibilityRegistry | null = null;
    try {
      if (existsSync(path)) registry = parseRegistry(readFileSync(path, 'utf8'));
    } catch (err) {
      logger.warn({ err, path }, 'Failed to load AdCP 4.0 compatibility registry');
    }
    registryCache.set(path, registry);
    if (registry) return registry;
  }
  return null;
}

// ── Evidence from a ComplianceResult ────────────────────────────────

type RunnerStep = {
  step?: unknown;
  step_id?: unknown;
  task?: unknown;
  skipped?: boolean;
  validations?: unknown;
};

/** Resolves a flattened runner step to its authored step id in the pinned bundle. */
export type V4StepIdResolver = (
  result: ComplianceResult,
  storyboardId: string,
  phaseId: string,
  step: RunnerStep,
) => string | undefined;

const pinnedStoryboards = new WeakMap<ComplianceResult, Map<string, ReturnType<typeof getCachedComplianceStoryboardById>>>();

/**
 * Same lookup as compliance-testing.ts classifyRunStep: in the pinned
 * version/phase, match an unambiguous title+task pair.
 */
export const pinnedStepId: V4StepIdResolver = (result, storyboardId, phaseId, step) => {
  if (!result.adcp_version) return undefined;
  try {
    let byId = pinnedStoryboards.get(result);
    if (!byId) {
      byId = new Map();
      pinnedStoryboards.set(result, byId);
    }
    if (!byId.has(storyboardId)) {
      byId.set(storyboardId, getCachedComplianceStoryboardById(
        storyboardId,
        hostedComplianceOptions(hostedComplianceTarget(result.adcp_version)),
      ));
    }
    const storyboard = byId.get(storyboardId);
    const phase = storyboard?.phases.find(candidate => candidate.id === phaseId);
    const matches = phase?.steps.filter(candidate =>
      candidate.title === step.step && candidate.task === step.task) ?? [];
    return matches.length === 1 ? matches[0].id : undefined;
  } catch {
    return undefined;
  }
};

function stepValidations(value: unknown): V4StepEvidence['validations'] {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map(v => ({
      id: typeof v.id === 'string' ? v.id : undefined,
      passed: typeof v.passed === 'boolean' ? v.passed : undefined,
      not_applicable: v.not_applicable === true,
    }));
}

/**
 * Collect grading evidence from a run. `stepStoryboards`, when given, limits
 * step attribution to the storyboards the registry grades in, so unrelated
 * steps never pay for a pinned-bundle lookup.
 */
export function v4ReadinessEvidenceFromComplianceResult(
  result: ComplianceResult,
  resolveStepId: V4StepIdResolver = pinnedStepId,
  stepStoryboards?: ReadonlySet<string>,
): V4ReadinessEvidence {
  const storyboardsRun = new Set<string>();
  const steps: V4StepEvidence[] = [];

  for (const track of result.tracks ?? []) {
    for (const scenario of track.scenarios ?? []) {
      const scenarioId = typeof scenario.scenario === 'string' ? scenario.scenario : '';
      const sepIdx = scenarioId.lastIndexOf('/');
      if (sepIdx <= 0) continue;
      const storyboardId = scenarioId.slice(0, sepIdx);
      const phaseId = scenarioId.slice(sepIdx + 1);
      storyboardsRun.add(storyboardId);
      if (stepStoryboards && !stepStoryboards.has(storyboardId)) continue;
      for (const step of ((scenario as { steps?: RunnerStep[] }).steps ?? [])) {
        const stepId = typeof step.step_id === 'string' && step.step_id
          ? step.step_id
          : resolveStepId(result, storyboardId, phaseId, step);
        if (!stepId) continue;
        steps.push({
          storyboard_id: storyboardId,
          step_id: stepId,
          skipped: step.skipped === true,
          validations: stepValidations(step.validations),
        });
      }
    }
  }

  // The runner's failure summaries carry the step id and the first failed
  // validation's id even when the track projection dropped both.
  for (const failure of result.failures ?? []) {
    const id = failure.validation?.id;
    if (!failure.storyboard_id || !failure.step_id || typeof id !== 'string') continue;
    storyboardsRun.add(failure.storyboard_id);
    steps.push({
      storyboard_id: failure.storyboard_id,
      step_id: failure.step_id,
      skipped: false,
      failed_validation_ids: [id],
    });
  }

  // Same precedence as complianceResultToDbInput: top-level notices, else the
  // legacy summary location.
  const withNotices = result as { notices?: unknown; summary?: { notices?: unknown } };
  const notices = withNotices.notices !== undefined ? withNotices.notices : withNotices.summary?.notices;
  const noticeCodes = Array.isArray(notices)
    ? notices
      .map(notice => (notice && typeof notice === 'object' ? (notice as { code?: unknown }).code : undefined))
      .filter((code): code is string => typeof code === 'string')
    : [];

  return { storyboards_run: [...storyboardsRun], steps, notice_codes: noticeCodes };
}

/**
 * Report for one run, or null when no registry is available. Never throws:
 * an advisory report must not block persisting the run.
 */
export function v4ReadinessReportForComplianceResult(result: ComplianceResult): V4ReadinessReport | null {
  try {
    const registry = loadV4CompatibilityRegistry(result.adcp_version);
    if (!registry) return null;
    const stepStoryboards = new Set(registry.checks
      .map(check => check.observed_by.validation?.storyboard)
      .filter((id): id is string => typeof id === 'string'));
    return deriveV4ReadinessReport(
      registry,
      v4ReadinessEvidenceFromComplianceResult(result, pinnedStepId, stepStoryboards),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to derive AdCP 4.0 readiness report');
    return null;
  }
}
