/**
 * Compliance testing — thin adapter over @adcp/client's compliance module.
 *
 * Re-exports the client's comply(), types, platform profiles, and briefs.
 * Adds complianceResultToDbInput() for recording results in the database.
 */

import {
  setAgentTesterLogger,
  comply,
  type ComplyOptions,
  type ComplianceResult,
  type ComplianceTrack,
  type TrackResult,
  type AdvisoryObservation,
  type PlatformType,
  type SampleBrief,
  type PlatformProfile,
  getAllPlatformTypes,
  getPlatformProfile,
  SAMPLE_BRIEFS,
  getBriefsByVertical,
  filterToKnownScenarios,
} from '@adcp/client/testing';

import type {
  TrackSummaryEntry,
  OverallRunStatus,
  RecordComplianceRunInput,
  StoryboardStatusEntry,
  LifecycleStage,
  TriggeredBy,
} from '../../db/compliance-db.js';

import { getStoryboard, getAllStoryboards } from '../../services/storyboards.js';
import type { Storyboard } from '../../services/storyboards.js';

// ── Re-exports ────────────────────────────────────────────────────

export { setAgentTesterLogger };
export { comply, getAllPlatformTypes, getPlatformProfile, SAMPLE_BRIEFS, getBriefsByVertical, filterToKnownScenarios };
export type {
  ComplyOptions,
  ComplianceResult,
  ComplianceTrack,
  TrackResult,
  AdvisoryObservation,
  PlatformType,
  SampleBrief,
  PlatformProfile,
};

// ── DB Adapter ────────────────────────────────────────────────────

/**
 * Map the client's OverallStatus to the DB's OverallRunStatus.
 * The client has 'auth_required' and 'unreachable' which we map to 'failing'.
 */
function mapOverallStatus(status: string): OverallRunStatus {
  switch (status) {
    case 'passing': return 'passing';
    case 'partial': return 'partial';
    case 'failing':
    case 'auth_required':
    case 'unreachable':
    default:
      return 'failing';
  }
}

// ── Storyboard Status Derivation ─────────────────────────────────

/**
 * Derive per-storyboard pass/fail from a compliance result.
 *
 * Maps scenario results back to storyboard steps via comply_scenario.
 * For explicit runs (storyboardIds provided), only those storyboards
 * are evaluated. For heartbeat runs, all storyboards with matching
 * scenarios are evaluated.
 */
export function deriveStoryboardStatuses(
  result: ComplianceResult,
  storyboardIds?: string[],
): StoryboardStatusEntry[] {
  // Build scenario → passed map from all track results
  const scenarioResults = new Map<string, boolean>();
  for (const track of result.tracks) {
    for (const s of track.scenarios) {
      scenarioResults.set(s.scenario, s.overall_passed);
    }
  }

  if (scenarioResults.size === 0) return [];

  const storyboardsToCheck: Storyboard[] = storyboardIds
    ? storyboardIds.map(id => getStoryboard(id)).filter((s): s is Storyboard => !!s)
    : getAllStoryboards();

  const entries: StoryboardStatusEntry[] = [];

  for (const sb of storyboardsToCheck) {
    // Collect steps with comply_scenario
    const testableSteps: Array<{ stepId: string; scenario: string }> = [];
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        if (step.comply_scenario) {
          testableSteps.push({ stepId: step.id, scenario: step.comply_scenario });
        }
      }
    }

    if (testableSteps.length === 0) continue;

    // Only include storyboards where at least one scenario was tested
    const testedCount = testableSteps.filter(s => scenarioResults.has(s.scenario)).length;
    if (testedCount === 0 && !storyboardIds) continue;

    const passedCount = testableSteps.filter(s => scenarioResults.get(s.scenario) === true).length;
    const totalSteps = testableSteps.length;

    let status: StoryboardStatusEntry['status'];
    if (testedCount === 0) {
      status = 'untested';
    } else if (passedCount === totalSteps) {
      status = 'passing';
    } else if (passedCount === 0) {
      status = 'failing';
    } else {
      status = 'partial';
    }

    entries.push({
      storyboard_id: sb.id,
      status,
      steps_passed: passedCount,
      steps_total: totalSteps,
    });
  }

  return entries;
}

// ── DB Adapter ────────────────────────────────────────────────────

/**
 * Convert a ComplianceResult from @adcp/client into the shape expected
 * by ComplianceDatabase.recordComplianceRun().
 */
export function complianceResultToDbInput(
  result: ComplianceResult,
  agentUrl: string,
  lifecycleStage: LifecycleStage,
  triggeredBy: TriggeredBy = 'manual',
  storyboardIds?: string[],
): RecordComplianceRunInput {
  const tracksJson: TrackSummaryEntry[] = result.tracks.map((t: TrackResult) => ({
    track: t.track,
    status: t.status === 'expected' ? 'skip' as const : t.status,
    scenario_count: t.scenarios.length,
    passed_count: t.scenarios.filter((s: { overall_passed: boolean }) => s.overall_passed).length,
    duration_ms: t.duration_ms,
  }));

  return {
    agent_url: agentUrl,
    lifecycle_stage: lifecycleStage,
    overall_status: mapOverallStatus(result.overall_status),
    headline: result.summary.headline,
    total_duration_ms: result.total_duration_ms,
    tracks_json: tracksJson,
    tracks_passed: result.summary.tracks_passed,
    tracks_failed: result.summary.tracks_failed,
    tracks_skipped: result.summary.tracks_skipped,
    tracks_partial: result.summary.tracks_partial,
    agent_profile_json: result.agent_profile,
    observations_json: result.observations,
    triggered_by: triggeredBy,
    dry_run: result.dry_run,
    storyboard_statuses: deriveStoryboardStatuses(result, storyboardIds),
  };
}
