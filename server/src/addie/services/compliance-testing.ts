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

import { isStableSpecialism, type AdcpProtocol } from '../../services/adcp-taxonomy.js';

/**
 * AAO Verified badge roles map to AdCP protocols (enums/adcp-protocol.json).
 * Each declared specialism rolls up to exactly one protocol.
 */
export type BadgeRole = AdcpProtocol;

/**
 * Specialism metadata: parent protocol + root storyboard ID
 * (the `id:` field in static/compliance/source/specialisms/{specialism}/index.yaml).
 *
 * The agent declares specialisms in get_adcp_capabilities; the compliance runner
 * reports pass/fail keyed by storyboard_id. This table connects the two.
 *
 * TODO(adcp-client#553): once @adcp/client exposes specialism results directly,
 * drop the storyboard_id lookup and trust the runner output.
 */
interface SpecialismInfo {
  protocol: BadgeRole;
  storyboard_id: string;
}

const SPECIALISM_CATALOG: Record<string, SpecialismInfo> = {
  // media-buy
  'audience-sync': { protocol: 'media-buy', storyboard_id: 'audience_sync' },
  'sales-broadcast-tv': { protocol: 'media-buy', storyboard_id: 'sales_broadcast_tv' },
  'sales-catalog-driven': { protocol: 'media-buy', storyboard_id: 'sales_catalog_driven' },
  'sales-exchange': { protocol: 'media-buy', storyboard_id: 'sales_exchange' },
  'sales-guaranteed': { protocol: 'media-buy', storyboard_id: 'sales_guaranteed' },
  'sales-non-guaranteed': { protocol: 'media-buy', storyboard_id: 'sales_non_guaranteed' },
  'sales-proposal-mode': { protocol: 'media-buy', storyboard_id: 'sales_proposal_mode' },
  'sales-retail-media': { protocol: 'media-buy', storyboard_id: 'sales_retail_media' },
  'sales-social': { protocol: 'media-buy', storyboard_id: 'sales_social' },
  'sales-streaming-tv': { protocol: 'media-buy', storyboard_id: 'sales_streaming_tv' },
  'signed-requests': { protocol: 'media-buy', storyboard_id: 'signed_requests' },
  // creative
  'creative-ad-server': { protocol: 'creative', storyboard_id: 'creative_ad_server' },
  'creative-generative': { protocol: 'creative', storyboard_id: 'creative_generative' },
  'creative-template': { protocol: 'creative', storyboard_id: 'creative_template' },
  // signals
  'signal-marketplace': { protocol: 'signals', storyboard_id: 'signal_marketplace' },
  'signal-owned': { protocol: 'signals', storyboard_id: 'signal_owned' },
  // governance
  'collection-lists': { protocol: 'governance', storyboard_id: 'collection_lists' },
  'content-standards': { protocol: 'governance', storyboard_id: 'content_standards' },
  'governance-delivery-monitor': { protocol: 'governance', storyboard_id: 'governance_delivery_monitor' },
  'governance-spend-authority': { protocol: 'governance', storyboard_id: 'governance_spend_authority' },
  'measurement-verification': { protocol: 'governance', storyboard_id: 'measurement_verification' },
  'property-lists': { protocol: 'governance', storyboard_id: 'property_lists' },
  // brand
  'brand-rights': { protocol: 'brand', storyboard_id: 'brand_rights' },
};

export interface VerificationResult {
  verified: boolean;
  roles: Array<{
    role: BadgeRole;
    verified: boolean;
    specialisms: string[];
    passing: string[];
    failing: string[];
  }>;
}

/**
 * Determine which badge roles an agent qualifies for based on its
 * declared specialisms and their pass/fail status.
 *
 * An agent earns a role badge when ALL declared specialisms that
 * roll up to that domain are passing. Specialisms come from the
 * agent's get_adcp_capabilities response (specialisms field).
 */
export function deriveVerificationStatus(
  declaredSpecialisms: string[],
  storyboardStatuses: StoryboardStatusEntry[],
): VerificationResult {
  if (declaredSpecialisms.length === 0) {
    return { verified: false, roles: [] };
  }

  const statusMap = new Map<string, StoryboardStatusEntry>();
  for (const entry of storyboardStatuses) {
    statusMap.set(entry.storyboard_id, entry);
  }

  // Preview specialisms are tested but don't count toward stable badge issuance.
  // They'll be reported separately once the compliance runner emits preview results.
  const stableSpecialisms = declaredSpecialisms.filter(isStableSpecialism);

  // Group declared specialisms by the protocol they roll up to
  const protocolSpecialisms = new Map<BadgeRole, string[]>();
  for (const specialism of stableSpecialisms) {
    const info = SPECIALISM_CATALOG[specialism];
    if (!info) continue;
    const existing = protocolSpecialisms.get(info.protocol) || [];
    existing.push(specialism);
    protocolSpecialisms.set(info.protocol, existing);
  }

  const roles: VerificationResult['roles'] = [];
  for (const [role, specialisms] of protocolSpecialisms) {
    const passing: string[] = [];
    const failing: string[] = [];
    for (const specialism of specialisms) {
      const info = SPECIALISM_CATALOG[specialism];
      const status = info ? statusMap.get(info.storyboard_id) : undefined;
      if (status?.status === 'passing') {
        passing.push(specialism);
      } else {
        failing.push(specialism);
      }
    }
    roles.push({
      role,
      verified: failing.length === 0 && passing.length > 0,
      specialisms,
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
