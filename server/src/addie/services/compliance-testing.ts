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
  type SampleBrief,
  SAMPLE_BRIEFS,
  getBriefsByVertical,
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
export { comply, SAMPLE_BRIEFS, getBriefsByVertical };
export type {
  ComplyOptions,
  ComplianceResult,
  ComplianceTrack,
  TrackResult,
  AdvisoryObservation,
  SampleBrief,
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

// ── Verification Status Derivation ───────────────────────────────

export type BadgeRole = 'sales' | 'buying' | 'creative' | 'governance' | 'signals' | 'measurement';

/**
 * Maps storyboard tracks to badge roles. A storyboard's track determines
 * which role badge it counts toward. Core and error_handling storyboards
 * are not role-specific — they're tested but don't determine role eligibility.
 */
const TRACK_TO_ROLE: Record<string, BadgeRole> = {
  media_buy: 'sales',
  creative: 'creative',
  signals: 'signals',
  governance: 'governance',
  campaign_governance: 'governance',
  audiences: 'signals',
  products: 'sales',
  si: 'sales',
};

export interface VerificationResult {
  verified: boolean;
  roles: Array<{
    role: BadgeRole;
    verified: boolean;
    storyboards: string[];
    passing: string[];
    failing: string[];
  }>;
}

/**
 * Determine which badge roles an agent qualifies for based on
 * declared storyboards and their pass/fail status.
 *
 * An agent is verified for a role when ALL declared storyboards
 * that map to that role are passing. The declared storyboards
 * come from the agent's get_adcp_capabilities response.
 */
export function deriveVerificationStatus(
  declaredStoryboards: string[],
  storyboardStatuses: StoryboardStatusEntry[],
): VerificationResult {
  if (declaredStoryboards.length === 0) {
    return { verified: false, roles: [] };
  }

  // Build a status map from the latest compliance results
  const statusMap = new Map<string, StoryboardStatusEntry>();
  for (const entry of storyboardStatuses) {
    statusMap.set(entry.storyboard_id, entry);
  }

  // Group declared storyboards by role
  const roleStoryboards = new Map<BadgeRole, string[]>();
  for (const sbId of declaredStoryboards) {
    const sb = getStoryboard(sbId);
    if (!sb) continue;

    const role = TRACK_TO_ROLE[sb.track || ''];
    if (!role) continue; // core/error_handling storyboards don't map to a role badge

    const existing = roleStoryboards.get(role) || [];
    existing.push(sbId);
    roleStoryboards.set(role, existing);
  }

  const roles: VerificationResult['roles'] = [];

  for (const [role, storyboards] of roleStoryboards) {
    const passing: string[] = [];
    const failing: string[] = [];

    for (const sbId of storyboards) {
      const status = statusMap.get(sbId);
      if (status?.status === 'passing') {
        passing.push(sbId);
      } else {
        failing.push(sbId);
      }
    }

    roles.push({
      role,
      verified: failing.length === 0 && passing.length > 0,
      storyboards,
      passing,
      failing,
    });
  }

  const verified = roles.some(r => r.verified);
  return { verified, roles };
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
    status: t.status,
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
    dry_run: true,
    storyboard_statuses: deriveStoryboardStatuses(result, storyboardIds),
  };
}
