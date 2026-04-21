/**
 * Compliance testing — thin adapter over @adcp/client's compliance module.
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

// ── Capability-resolution error classification ───────────────────
//
// `@adcp/client`'s `resolveStoryboardsForCapabilities` fails closed with
// plain `Error` instances for two distinct agent-config problems:
//   1. Declared specialism whose parent protocol isn't in supported_protocols.
//   2. Declared specialism whose bundle isn't in the local compliance cache.
// Both surface through `comply()` and any caller that invokes the resolver
// directly. They are *agent-config* faults (or, for #2, a stale local cache),
// not platform errors — callers should log at warn and return actionable
// coaching, not alarm on them as system failures.
//
// Until @adcp/client exports typed errors (tracked upstream at
// adcontextprotocol/adcp-client#734), we classify by message regex. The
// patterns match the exact strings thrown at
// node_modules/@adcp/client/dist/lib/testing/storyboard/compliance.js:337
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
