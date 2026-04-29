/**
 * Compliance testing — thin adapter over @adcp/sdk's compliance module.
 *
 * Re-exports the client's comply(), types, platform profiles, and briefs.
 * Adds complianceResultToDbInput() for recording results in the database.
 */

import {
  setAgentTesterLogger,
  comply,
  loadComplianceIndex,
  type ComplyOptions,
  type ComplianceResult,
  type ComplianceTrack,
  type TrackResult,
  type AdvisoryObservation,
  type SampleBrief,
  SAMPLE_BRIEFS,
  getBriefsByVertical,
} from '@adcp/sdk/testing';

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

// ── Capability-resolution error classification ───────────────────
//
// `@adcp/sdk`'s `resolveStoryboardsForCapabilities` fails closed with
// plain `Error` instances for two distinct agent-config problems:
//   1. Declared specialism whose parent protocol isn't in supported_protocols.
//   2. Declared specialism whose bundle isn't in the local compliance cache.
// Both surface through `comply()` and any caller that invokes the resolver
// directly. They are *agent-config* faults (or, for #2, a stale local cache),
// not platform errors — callers should log at warn and return actionable
// coaching, not alarm on them as system failures.
//
// Until @adcp/sdk exports typed errors (tracked upstream at
// adcontextprotocol/adcp-client#734), we classify by message regex. The
// patterns match the exact strings thrown at
// node_modules/@adcp/sdk/dist/lib/testing/storyboard/compliance.js:337
// and :347. Swap to `instanceof` checks once the SDK emits coded errors.
//
// Security notes:
//   - The captured groups echo agent-declared content. Regex is anchored at
//     start and the captures forbid newlines, quotes, and parens so a
//     hostile specialism id can't smuggle an injection payload through.
//   - Captures are length-capped at the regex level (further sanitized
//     through `sanitizeClassifiedValue`) so a multi-megabyte specialism
//     id can't balloon logs / DB rows / LLM context.
//   - For `parent_protocol_missing`, we additionally verify the extracted
//     parent against the local compliance index — the resolver only throws
//     this variant when the specialism IS in the index, so a mismatch means
//     the message was synthesised by the attacker. In that case we fall
//     through to `unknown_specialism` rather than trusting the field.

export type CapabilityResolutionErrorKind =
  | 'specialism_parent_protocol_missing'
  | 'unknown_specialism';

export interface CapabilityResolutionErrorInfo {
  kind: CapabilityResolutionErrorKind;
  specialism?: string;
  parentProtocol?: string;
}

// Anchored at start of message. Specialism capture forbids `"\r\n` (ends the
// quoted token in the upstream string). Parent capture forbids `)\r\n`
// (ends the parenthesised aside). Hard length cap at 256 per capture.
const PARENT_PROTOCOL_MISSING_RE =
  /^Agent declared specialism "([^"\r\n]{1,256})" \(parent protocol: ([^)\r\n]{1,256})\) but did not include/;
const UNKNOWN_SPECIALISM_RE =
  /^Agent declared specialism "([^"\r\n]{1,256})" but no bundle exists/;

// Strip control chars, backticks, and collapse whitespace on extracted
// values. Backticks would break markdown fences in Addie-facing output;
// control chars would break Slack notification rendering (via the DB
// `headline` → Slack DM title path in notifications/compliance.ts).
function sanitizeClassifiedValue(value: string, maxLen = 120): string {
  return value
    .replace(/[\r\n`\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function knownProtocolsFromIndex(): Set<string> {
  try {
    const index = loadComplianceIndex();
    return new Set(index.specialisms.map(s => s.protocol).filter(Boolean));
  } catch {
    // Cache unavailable — accept the extracted value without cross-check.
    // The anchored regex + sanitizer still bound what can reach downstream.
    return new Set();
  }
}

export function classifyCapabilityResolutionError(
  err: unknown,
): CapabilityResolutionErrorInfo | undefined {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return undefined;

  const parentMatch = msg.match(PARENT_PROTOCOL_MISSING_RE);
  if (parentMatch) {
    const specialism = sanitizeClassifiedValue(parentMatch[1]);
    const parentProtocol = sanitizeClassifiedValue(parentMatch[2]);
    // Defense in depth: the upstream resolver only throws this variant when
    // the specialism exists in the local index, so its parent is a known
    // protocol. If the extracted parent isn't known, the attacker smuggled
    // the structure — fall through to `unknown_specialism`.
    const known = knownProtocolsFromIndex();
    if (known.size === 0 || known.has(parentProtocol)) {
      return {
        kind: 'specialism_parent_protocol_missing',
        specialism,
        parentProtocol,
      };
    }
    return { kind: 'unknown_specialism', specialism };
  }

  const unknownMatch = msg.match(UNKNOWN_SPECIALISM_RE);
  if (unknownMatch) {
    return {
      kind: 'unknown_specialism',
      specialism: sanitizeClassifiedValue(unknownMatch[1]),
    };
  }

  return undefined;
}

// ── Capability-resolution error presentation ────────────────────
//
// Central formatter so every caller (heartbeat, MCP tools, REST route) emits
// consistent prose and the three sinks (DB headline, LLM markdown, JSON
// response) get correctly-sanitized or correctly-fenced strings. Returning
// structured shapes rather than naked strings keeps the callers honest about
// which surface they're writing to.

export interface CapabilityResolutionErrorPresentation {
  /** Plain-text single-line headline. Safe for DB columns and Slack DM titles. */
  headline: string;
  /** Structured log fields for `logger.warn({...}, msg)`. */
  logMsg: string;
  logFields: Record<string, string>;
  /** Structured fields for REST JSON response bodies. */
  restBody: Record<string, string>;
}

export function presentCapabilityResolutionError(
  info: CapabilityResolutionErrorInfo,
): CapabilityResolutionErrorPresentation {
  const specialism = info.specialism ?? '';
  const parentProtocol = info.parentProtocol ?? '';

  if (info.kind === 'specialism_parent_protocol_missing') {
    return {
      headline:
        `Agent capabilities misconfigured: specialism "${specialism}" requires ` +
        `"${parentProtocol}" in supported_protocols.`,
      logMsg: 'Agent declared specialism without its parent protocol',
      logFields: { specialism, parentProtocol },
      restBody: {
        error_kind: 'specialism_parent_protocol_missing',
        specialism,
        parent_protocol: parentProtocol,
      },
    };
  }

  // unknown_specialism
  return {
    headline:
      `Agent declared specialism "${specialism}" that isn't in the local compliance ` +
      `cache (cache may be stale or the id is unrecognized).`,
    logMsg: 'Agent declared unknown specialism',
    logFields: { specialism },
    restBody: {
      error_kind: 'unknown_specialism',
      specialism,
    },
  };
}

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
  'sales-guaranteed': { protocol: 'media-buy', storyboard_id: 'sales_guaranteed' },
  'sales-non-guaranteed': { protocol: 'media-buy', storyboard_id: 'sales_non_guaranteed' },
  'sales-proposal-mode': { protocol: 'media-buy', storyboard_id: 'sales_proposal_mode' },
  'sales-social': { protocol: 'media-buy', storyboard_id: 'sales_social' },
  'signed-requests': { protocol: 'media-buy', storyboard_id: 'signed_requests' },
  'governance-aware-seller': { protocol: 'media-buy', storyboard_id: 'governance_aware_seller' },
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

export type SpecialismStatus = 'passing' | 'failing' | 'untested' | 'unknown';

/**
 * Map declared specialisms to per-specialism pass/fail/untested status by
 * looking up each specialism's storyboard in the latest run's storyboard
 * statuses. Used by the dashboard to mark which declared specialisms are
 * the cause of a `failing` overall status without forcing the user to
 * cross-reference the storyboard track pills.
 *
 * `unknown` is returned for specialisms not in `SPECIALISM_CATALOG` (e.g.
 * preview-status specialisms that the agent declared but the catalog
 * doesn't recognize as stable).
 */
export function computeSpecialismStatus(
  declaredSpecialisms: string[],
  storyboardStatuses: StoryboardStatusEntry[],
): Record<string, SpecialismStatus> {
  const statusMap = new Map<string, StoryboardStatusEntry>();
  for (const entry of storyboardStatuses) {
    statusMap.set(entry.storyboard_id, entry);
  }

  const result: Record<string, SpecialismStatus> = {};
  for (const specialism of declaredSpecialisms) {
    const info = SPECIALISM_CATALOG[specialism];
    if (!info) {
      result[specialism] = 'unknown';
      continue;
    }
    const sbStatus = statusMap.get(info.storyboard_id);
    if (!sbStatus) {
      result[specialism] = 'untested';
      continue;
    }
    if (sbStatus.status === 'passing') {
      result[specialism] = 'passing';
    } else if (sbStatus.status === 'failing' || sbStatus.status === 'partial') {
      result[specialism] = 'failing';
    } else {
      result[specialism] = 'untested';
    }
  }
  return result;
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
 * Convert a ComplianceResult from @adcp/sdk into the shape expected
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
