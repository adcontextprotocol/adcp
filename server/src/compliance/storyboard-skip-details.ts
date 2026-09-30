/**
 * Per-storyboard skip evidence for the owner dashboard drill-down (adcp#7798).
 *
 * `agent_storyboard_status.skipped_count` counts cascaded prerequisite skips,
 * but until now nothing recorded *which* steps were skipped or why, so the
 * dashboard could only say "N steps skipped". This walks the runner output
 * once and captures, per storyboard, the first few cascaded skips with their
 * runner-supplied reason/detail and the nearest earlier step in the same
 * storyboard that did not pass (the likely prerequisite).
 *
 * Detail text originates from third-party agents (echoed errors) and the
 * runner; it is redacted and length-capped here and must still be escaped at
 * render time.
 */

import { getComplianceStoryboardById, type ComplianceResult } from '@adcp/sdk/testing';
import { redactForDiagnostics } from '../addie/services/compliance-testing.js';
import { hostedComplianceOptions, hostedComplianceTarget } from '../services/hosted-compliance-version.js';
import type { RecordComplianceRunInput, StoryboardSkippedStep } from '../db/compliance-db.js';
import { classifyComplianceStep } from './step-disposition.js';

export const MAX_SKIPPED_STEPS_PER_STORYBOARD = 5;
const MAX_TEXT_LENGTH = 500;

type RunnerStep = {
  step?: unknown;
  step_id?: unknown;
  task?: unknown;
  passed?: boolean;
  skipped?: boolean;
  skip_reason?: string;
  skip?: { reason?: string; detail?: unknown };
  error?: unknown;
  details?: unknown;
  warnings?: unknown;
};

/** Resolves the pinned storyboard step's `requires_tool`, if unambiguous. */
export type StepRequiredToolResolver = (
  result: ComplianceResult,
  storyboardId: string,
  phaseId: string,
  step: { step_id?: unknown; step?: unknown; task?: unknown },
) => string | undefined;

/**
 * Same lookup as compliance-testing.ts classifyRunStep: in the pinned
 * version/phase, match by step id, else by an unambiguous title+task pair.
 */
export const pinnedStepRequiredTool: StepRequiredToolResolver = (result, storyboardId, phaseId, step) => {
  if (!result.adcp_version) return undefined;
  try {
    const storyboard = getComplianceStoryboardById(
      storyboardId,
      hostedComplianceOptions(hostedComplianceTarget(result.adcp_version)),
    );
    const phase = storyboard?.phases.find(candidate => candidate.id === phaseId);
    const matches = phase?.steps.filter(candidate => step.step_id
      ? candidate.id === step.step_id
      : candidate.title === step.step && candidate.task === step.task) ?? [];
    const tool = matches.length === 1 ? matches[0].requires_tool : undefined;
    return typeof tool === 'string' ? tool : undefined;
  } catch {
    return undefined;
  }
};

interface Blocker {
  stepId: string | null;
  title: string | null;
  reason: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Must match compliance-testing.ts slugifyStepId so ids line up with first_failed_step_id. */
function slugifyStepId(value: string | null): string | null {
  if (!value) return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug || null;
}

function safeText(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const redacted = redactForDiagnostics(text);
  const out = typeof redacted === 'string' ? redacted : '[redacted]';
  return out.length > MAX_TEXT_LENGTH ? `${out.slice(0, MAX_TEXT_LENGTH)}...` : out;
}

function stepIdentity(step: RunnerStep): { stepId: string | null; title: string | null; task: string | null } {
  const title = nonEmptyString(step.step);
  return {
    stepId: nonEmptyString(step.step_id) ?? slugifyStepId(title),
    title,
    task: nonEmptyString(step.task),
  };
}

function skipDetail(step: RunnerStep): string | null {
  const warning = Array.isArray(step.warnings)
    ? step.warnings.find((w): w is string => typeof w === 'string' && w.trim().length > 0)
    : undefined;
  return safeText(nonEmptyString(step.skip?.detail) ?? warning ?? nonEmptyString(step.error) ?? nonEmptyString(step.details));
}

function skipReason(step: RunnerStep): string | null {
  return nonEmptyString(step.skip_reason) ?? nonEmptyString(step.skip?.reason);
}

/**
 * Collect cascaded prerequisite skips per storyboard, in runner order.
 *
 * Mirrors how deriveStoryboardStatuses (via classifyRunStep) counts
 * `skipped_count`: a `dependency_failed` disposition, minus prerequisite
 * skips whose pinned step requires an optional tool the agent does not
 * advertise (not_applicable), minus prerequisite skips after a
 * `fixture_unavailable` preflight abort (setup gaps).
 */
export function collectStoryboardSkippedSteps(
  result: ComplianceResult,
  resolveRequiredTool: StepRequiredToolResolver = pinnedStepRequiredTool,
): Map<string, StoryboardSkippedStep[]> {
  const advertisedTools = Array.isArray(result.agent_profile?.tools) ? result.agent_profile.tools : null;
  const optionalToolUnavailable = (storyboardId: string, phaseId: string, step: RunnerStep): boolean => {
    if (!advertisedTools || !result.adcp_version) return false;
    const tool = resolveRequiredTool(result, storyboardId, phaseId, step);
    return typeof tool === 'string' && !advertisedTools.includes(tool);
  };
  const out = new Map<string, StoryboardSkippedStep[]>();
  const lastBlocker = new Map<string, Blocker>();
  const fixtureAborted = new Set<string>();

  for (const track of result.tracks ?? []) {
    for (const scenario of track.scenarios ?? []) {
      const scenarioId = typeof scenario.scenario === 'string' ? scenario.scenario : '';
      const sepIdx = scenarioId.lastIndexOf('/');
      if (sepIdx <= 0) continue;
      const storyboardId = scenarioId.slice(0, sepIdx);
      const phaseId = scenarioId.slice(sepIdx + 1);
      const steps = (scenario as { steps?: RunnerStep[] }).steps;
      if (!Array.isArray(steps)) continue;

      for (const step of steps) {
        const reason = skipReason(step);
        if (step.skipped && reason === 'fixture_unavailable') fixtureAborted.add(storyboardId);
        // Graded not_applicable, not a cascade and not a blocker for later steps.
        if (step.skipped && step.skip_reason === 'prerequisite_failed' &&
          optionalToolUnavailable(storyboardId, phaseId, step)) continue;

        const disposition = classifyComplianceStep(step as Parameters<typeof classifyComplianceStep>[0], scenarioId);
        if (disposition === 'dependency_failed' && !fixtureAborted.has(storyboardId)) {
          const list = out.get(storyboardId) ?? [];
          out.set(storyboardId, list);
          if (list.length < MAX_SKIPPED_STEPS_PER_STORYBOARD) {
            const identity = stepIdentity(step);
            const blocker = lastBlocker.get(storyboardId) ?? null;
            list.push({
              step_id: identity.stepId,
              title: identity.title,
              task: identity.task,
              reason,
              detail: skipDetail(step),
              blocked_by_step_id: blocker?.stepId ?? null,
              blocked_by_step_title: blocker?.title ?? null,
              blocked_by_reason: blocker?.reason ?? null,
            });
          }
          continue;
        }

        // Any earlier step that did not cleanly pass can be the prerequisite
        // the runner cascaded from: a failure, or a skip for another reason
        // (e.g. not_applicable, unresolved context, missing tool).
        if (!step.skipped && step.passed === false) {
          const identity = stepIdentity(step);
          lastBlocker.set(storyboardId, { stepId: identity.stepId, title: identity.title, reason: 'failed' });
        } else if (step.skipped) {
          const identity = stepIdentity(step);
          lastBlocker.set(storyboardId, {
            stepId: identity.stepId,
            title: identity.title,
            reason: reason ?? 'skipped',
          });
        }
      }
    }
  }
  return out;
}

/**
 * Attach `skipped_steps` to each storyboard status row that reports skips.
 * Mutates and returns `dbInput` so call sites stay one line.
 */
export function withStoryboardSkipDetails<T extends Pick<RecordComplianceRunInput, 'storyboard_statuses'>>(
  dbInput: T,
  result: ComplianceResult,
): T {
  const statuses = dbInput.storyboard_statuses;
  if (!statuses?.length) return dbInput;
  let skipped: Map<string, StoryboardSkippedStep[]> | null = null;
  for (const entry of statuses) {
    if (!entry.skipped_count || entry.skipped_count <= 0) continue;
    skipped ??= collectStoryboardSkippedSteps(result);
    const steps = skipped.get(entry.storyboard_id);
    if (steps?.length) entry.skipped_steps = steps;
  }
  return dbInput;
}
