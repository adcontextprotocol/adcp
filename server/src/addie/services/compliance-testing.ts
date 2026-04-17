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

/**
 * AAO Verified badge roles map to AdCP domains.
 * Each declared specialism rolls up to exactly one domain.
 */
export type BadgeRole = 'media-buy' | 'creative' | 'signals' | 'governance' | 'brand' | 'sponsored-intelligence';

/**
 * Specialism metadata: which domain it rolls up to, plus its root storyboard ID
 * (the `id:` field in static/compliance/source/specialisms/{specialism}/index.yaml).
 *
 * The agent declares specialisms in get_adcp_capabilities; the compliance runner
 * reports pass/fail keyed by storyboard_id. This table connects the two.
 *
 * TODO(adcp-client#553): once @adcp/client exposes specialism results directly,
 * drop the storyboard_id lookup and trust the runner output.
 */
interface SpecialismInfo {
  domain: BadgeRole;
  storyboard_id: string;
}

const SPECIALISM_CATALOG: Record<string, SpecialismInfo> = {
  // media-buy
  'sales-broadcast-tv': { domain: 'media-buy', storyboard_id: 'media_buy_broadcast_seller' },
  'sales-catalog-driven': { domain: 'media-buy', storyboard_id: 'media_buy_catalog_creative' },
  'sales-exchange': { domain: 'media-buy', storyboard_id: 'sales_exchange' },
  'sales-guaranteed': { domain: 'media-buy', storyboard_id: 'media_buy_guaranteed_approval' },
  'sales-non-guaranteed': { domain: 'media-buy', storyboard_id: 'media_buy_non_guaranteed' },
  'sales-proposal-mode': { domain: 'media-buy', storyboard_id: 'media_buy_proposal_mode' },
  'sales-retail-media': { domain: 'media-buy', storyboard_id: 'sales_retail_media' },
  'sales-social': { domain: 'media-buy', storyboard_id: 'social_platform' },
  'sales-streaming-tv': { domain: 'media-buy', storyboard_id: 'sales_streaming_tv' },
  // creative
  'creative-ad-server': { domain: 'creative', storyboard_id: 'creative_ad_server' },
  'creative-generative': { domain: 'creative', storyboard_id: 'creative_generative' },
  'creative-template': { domain: 'creative', storyboard_id: 'creative_template' },
  // signals
  'audience-sync': { domain: 'signals', storyboard_id: 'audience_sync' },
  'signal-marketplace': { domain: 'signals', storyboard_id: 'signal_marketplace' },
  'signal-owned': { domain: 'signals', storyboard_id: 'signal_owned' },
  // governance
  'content-standards': { domain: 'governance', storyboard_id: 'content_standards' },
  'governance-delivery-monitor': { domain: 'governance', storyboard_id: 'campaign_governance_delivery' },
  'governance-spend-authority': { domain: 'governance', storyboard_id: 'campaign_governance_conditions' },
  'inventory-lists': { domain: 'governance', storyboard_id: 'inventory_lists' },
  'measurement-verification': { domain: 'governance', storyboard_id: 'measurement_verification' },
  // brand
  'brand-rights': { domain: 'brand', storyboard_id: 'brand_rights' },
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

  // Group declared specialisms by the domain they roll up to
  const domainSpecialisms = new Map<BadgeRole, string[]>();
  for (const specialism of declaredSpecialisms) {
    const info = SPECIALISM_CATALOG[specialism];
    if (!info) continue;
    const existing = domainSpecialisms.get(info.domain) || [];
    existing.push(specialism);
    domainSpecialisms.set(info.domain, existing);
  }

  const roles: VerificationResult['roles'] = [];
  for (const [role, specialisms] of domainSpecialisms) {
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
