/**
 * Compliance testing — thin adapter over @adcp/sdk's compliance module.
 *
 * Re-exports the client's comply(), types, platform profiles, and briefs.
 * Adds complianceResultToDbInput() for recording results in the database.
 */

import {
  setAgentTesterLogger,
  comply as sdkComply,
  loadComplianceIndex as sdkLoadComplianceIndex,
  testCapabilityDiscovery,
  type ComplyOptions,
  type ComplianceResult,
  type ComplianceTrack,
  type TrackResult,
  type AdvisoryObservation,
  type SampleBrief,
  SAMPLE_BRIEFS,
  getBriefsByVertical,
  CapabilityResolutionError,
} from '@adcp/sdk/testing';
import {
  hostedComplianceTarget,
  hostedAuthProbeTaskForProfile,
  agentAdvertisesBadgeEligibleHostedComplianceTarget,
  badgeEligibleVersionsForHostedComplianceTarget,
  selectCanonicalHostedComplianceTargetForProfile,
  selectHostedComplianceTargetForProfile,
  withHostedComplianceRunOptions,
  type HostedComplianceTarget,
} from '../../services/hosted-compliance-version.js';
import { createLogger } from '../../logger.js';

import type {
  TrackSummaryEntry,
  OverallRunStatus,
  RecordComplianceRunInput,
  StoryboardStatusEntry,
  StepDiagnosticEntry,
  LifecycleStage,
  TriggeredBy,
} from '../../db/compliance-db.js';

const logger = createLogger('addie-compliance-testing');
const DEFAULT_TARGET_DISCOVERY_TIMEOUT_MS = 10_000;

export interface ComplianceTargetSelection {
  target: HostedComplianceTarget;
  confirmed: boolean;
  supportedVersions?: readonly string[];
}

function complianceTargetDiscoveryTimeoutMs(options: ComplyOptions): number {
  const requested = options.timeout_ms;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_TARGET_DISCOVERY_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(requested, DEFAULT_TARGET_DISCOVERY_TIMEOUT_MS));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ── Re-exports ────────────────────────────────────────────────────

export { setAgentTesterLogger };
export { SAMPLE_BRIEFS, getBriefsByVertical };
export type {
  ComplyOptions,
  ComplianceResult,
  ComplianceTrack,
  TrackResult,
  AdvisoryObservation,
  SampleBrief,
};

async function hostedAuthProbeTaskForRun(
  agentUrl: string,
  options: ComplyOptions,
): Promise<string | undefined> {
  const auth = options.auth;
  if (auth?.type !== 'bearer' && auth?.type !== 'basic') return undefined;
  if (options.test_kit?.auth?.probe_task) return options.test_kit.auth.probe_task;

  try {
    const discovery = await testCapabilityDiscovery(agentUrl, options);
    return hostedAuthProbeTaskForProfile(discovery.profile);
  } catch (err) {
    logger.warn({ err, agentUrl }, 'Could not pre-discover hosted auth probe task; using default');
    return undefined;
  }
}

export async function comply(
  agentUrl: string,
  options: ComplyOptions,
  target: HostedComplianceTarget,
): Promise<ComplianceResult> {
  const authProbeTask = await hostedAuthProbeTaskForRun(agentUrl, options);
  const result = await sdkComply(agentUrl, withHostedComplianceRunOptions(options, target, authProbeTask));
  result.adcp_version ??= target.version;
  (result as ComplianceResult & { requested_compliance_target?: string }).requested_compliance_target = target.requested;
  return result;
}

export function loadComplianceIndex(target: HostedComplianceTarget, options: ComplyOptions = {}) {
  return sdkLoadComplianceIndex(withHostedComplianceRunOptions(options, target));
}

export function defaultComplianceTarget(): HostedComplianceTarget {
  return hostedComplianceTarget();
}

export async function selectComplianceTargetForAgentSelection(
  agentUrl: string,
  options: ComplyOptions,
  fallback: HostedComplianceTarget = defaultComplianceTarget(),
  mode: 'preferred' | 'canonical' = 'preferred',
): Promise<ComplianceTargetSelection> {
  try {
    const discovery = await withTimeout(
      testCapabilityDiscovery(agentUrl, options),
      complianceTargetDiscoveryTimeoutMs(options),
      'Hosted compliance target pre-discovery',
    );
    const target = mode === 'canonical'
      ? selectCanonicalHostedComplianceTargetForProfile(discovery.profile, fallback)
      : selectHostedComplianceTargetForProfile(discovery.profile, fallback);
    return { target, confirmed: true, supportedVersions: discovery.profile?.adcp_supported_versions };
  } catch (err) {
    logger.warn({ err, agentUrl }, 'Could not pre-discover hosted compliance target; using fallback');
    return { target: fallback, confirmed: false };
  }
}

export async function selectComplianceTargetForAgent(
  agentUrl: string,
  options: ComplyOptions,
  fallback: HostedComplianceTarget = defaultComplianceTarget(),
  mode: 'preferred' | 'canonical' = 'preferred',
): Promise<HostedComplianceTarget> {
  const selection = await selectComplianceTargetForAgentSelection(agentUrl, options, fallback, mode);
  return selection.target;
}

export function badgeEligibleVersionsForTargetSelection(
  selection: ComplianceTargetSelection,
  profile?: { adcp_supported_versions?: readonly string[] },
): readonly string[] {
  const versions = badgeEligibleVersionsForHostedComplianceTarget(selection.target);
  if (versions.length === 0) return [];
  if (selection.confirmed) return versions;
  return agentAdvertisesBadgeEligibleHostedComplianceTarget(
    profile?.adcp_supported_versions ?? selection.supportedVersions,
    selection.target,
  )
    ? versions
    : [];
}

// ── Capability-resolution error classification ───────────────────
//
// `@adcp/sdk`'s `resolveStoryboardsForCapabilities` fails closed with
// agent-config problems:
//   1. Declared specialism whose parent protocol isn't in supported_protocols.
//   2. Declared specialism whose bundle isn't in the local compliance cache.
//   3. Selected compliance cache version isn't in adcp.supported_versions.
// They surface through `comply()` and any caller that invokes the resolver
// directly. They are *agent-config* or target-selection faults (or, for #2, a
// stale local cache), not platform errors — callers should log at warn and
// return actionable coaching, not alarm on them as system failures.
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
  | 'unknown_specialism'
  | 'unsupported_adcp_version';

export interface CapabilityResolutionErrorInfo {
  kind: CapabilityResolutionErrorKind;
  specialism?: string;
  parentProtocol?: string;
  complianceVersion?: string;
  supportedVersions?: string[];
}

// Anchored at start of message. Specialism capture forbids `"\r\n` (ends the
// quoted token in the upstream string). Parent capture forbids `)\r\n`
// (ends the parenthesised aside). Hard length cap at 256 per capture.
const PARENT_PROTOCOL_MISSING_RE =
  /^Agent declared specialism "([^"\r\n]{1,256})" \(parent protocol: ([^)\r\n]{1,256})\) but did not include/;
const UNKNOWN_SPECIALISM_RE =
  /^Agent declared specialism "([^"\r\n]{1,256})" but no bundle exists/;
const UNSUPPORTED_ADCP_VERSION_RE =
  /^Compliance cache version ([^\s\r\n]{1,80}) is not supported by this seller\. Seller advertises adcp\.supported_versions \[([^\]\r\n]{0,512})\]\./;
const SAFE_VERSION_TOKEN_RE = /^[0-9A-Za-z.+_-]{1,40}$/;

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

function parseSupportedVersionList(value: string): string[] {
  return value
    .split(',')
    .map(part => {
      const cleaned = sanitizeClassifiedValue(part, 40);
      return SAFE_VERSION_TOKEN_RE.test(cleaned) ? cleaned : '';
    })
    .filter(Boolean);
}

function knownProtocolsFromIndex(): Set<string> {
  try {
    const index = loadComplianceIndex(defaultComplianceTarget());
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

  if (err instanceof CapabilityResolutionError && err.code === 'unsupported_adcp_version') {
    const match = msg.match(UNSUPPORTED_ADCP_VERSION_RE);
    return {
      kind: 'unsupported_adcp_version',
      complianceVersion: match ? sanitizeClassifiedValue(match[1], 80) : undefined,
      supportedVersions: match ? parseSupportedVersionList(match[2]) : [],
    };
  }

  const unsupportedVersionMatch = msg.match(UNSUPPORTED_ADCP_VERSION_RE);
  if (unsupportedVersionMatch) {
    return {
      kind: 'unsupported_adcp_version',
      complianceVersion: sanitizeClassifiedValue(unsupportedVersionMatch[1], 80),
      supportedVersions: parseSupportedVersionList(unsupportedVersionMatch[2]),
    };
  }

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
  const complianceVersion = info.complianceVersion ?? '';
  const supportedVersions = info.supportedVersions ?? [];
  const supportedVersionsText = supportedVersions.length > 0 ? supportedVersions.join(', ') : '(none advertised)';

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

  if (info.kind === 'unsupported_adcp_version') {
    return {
      headline:
        `Agent does not support selected compliance cache "${complianceVersion}". ` +
        `Seller advertises adcp.supported_versions [${supportedVersionsText}].`,
      logMsg: 'Agent does not support selected compliance cache version',
      logFields: { complianceVersion, supportedVersions: supportedVersionsText },
      restBody: {
        error_kind: 'unsupported_adcp_version',
        compliance_version: complianceVersion,
        supported_versions: supportedVersionsText,
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

function skipReasonIsCoverageGap(reason: string | undefined): boolean {
  switch (reason) {
    case 'not_applicable':
    case 'peer_branch_taken':
    case 'peer_substituted':
      return false;
    default:
      return true;
  }
}

function trackHasCoverageGapSkip(track: TrackResult): boolean {
  for (const scenario of track.scenarios) {
    for (const step of scenario.steps ?? []) {
      if (step.skipped && skipReasonIsCoverageGap(step.skip_reason)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Derive the effective overall status and track counters from a ComplianceResult.
 *
 * The SDK reports overall_status='partial' when every track returns 'silent' (all
 * scenarios passed with no advisory observations — the best possible outcome).
 * 'partial' maps to ComplianceStatus='degraded', which is wrong for a fully-clean
 * run. When all active (non-skip) tracks are 'pass' or 'silent', override to
 * 'passing' and recompute track counters so DB records stay consistent.
 */
function effectiveRunStatus(result: ComplianceResult): {
  overall_status: OverallRunStatus;
  tracks_passed: number;
  tracks_failed: number;
  tracks_partial: number;
} {
  const activeTracks = result.tracks.filter((t: TrackResult) => t.status !== 'skip');
  const hasCoverageGapSkip = result.tracks.some(trackHasCoverageGapSkip);
  if (
    !hasCoverageGapSkip &&
    activeTracks.length > 0 &&
    activeTracks.every((t: TrackResult) => t.status === 'pass' || t.status === 'silent')
  ) {
    return {
      overall_status: 'passing',
      tracks_passed: activeTracks.length,
      tracks_failed: 0,
      tracks_partial: 0,
    };
  }
  return {
    overall_status: mapOverallStatus(result.overall_status),
    tracks_passed: result.summary.tracks_passed,
    tracks_failed: result.summary.tracks_failed,
    tracks_partial: result.summary.tracks_partial,
  };
}

// ── Storyboard Status Derivation ─────────────────────────────────

/**
 * Derive per-storyboard pass/fail from a compliance result.
 *
 * `comply()` emits one `TestResult` per *phase* of each storyboard it ran,
 * keyed `<storyboard_id>/<phase_id>` in `result.tracks[].scenarios[].scenario`
 * (see `@adcp/sdk` `compliance/storyboard-tracks.ts`). We group those by
 * storyboard id and roll step-level pass counts up from each phase's
 * `steps` array — which is what `agent_storyboard_status.steps_passed/total`
 * record.
 *
 * Modes:
 *   - heartbeat path (no `storyboardIds`): emit an entry for every storyboard
 *     the SDK actually produced data for.
 *   - explicit-IDs path (`storyboardIds` non-empty): emit one entry per id,
 *     with `status='untested'` for any id the SDK didn't run.
 *
 * `steps_passed` / `steps_total` reflect what the SDK reported for that
 * storyboard in this run. Two storyboards (or the same storyboard across
 * different runs) may count steps differently: most rows are real step
 * counts; rows where the SDK emitted phases without per-step data fall back
 * to phase-level counts. The values are meaningful within a single row
 * (passed/total ratio, status derivation) but should not be compared across
 * rows without checking which mode produced them.
 */
export function deriveStoryboardStatuses(
  result: ComplianceResult,
  storyboardIds?: string[],
): StoryboardStatusEntry[] {
  interface Aggregate {
    stepsPassed: number;
    stepsTotal: number;
    stepLessPhasesPassed: number;
    stepLessPhasesTotal: number;
    controllerSkipped: number;
  }
  const branchSkipReasons = new Set<string>([
    'peer_branch_taken',
    'peer_substituted',
  ]);
  const isControllerSkip = (step: { skip_reason?: string; requirement?: string }): boolean =>
    step.skip_reason === 'missing_test_controller' ||
    (step.skip_reason === 'requirement_unmet' && step.requirement === 'controller');
  const perStoryboard = new Map<string, Aggregate>();
  // Storyboard ids in `static/compliance/source/**/index.yaml` are flat
  // identifiers (no `/`); splitting on the first `/` therefore always yields
  // the storyboard id followed by the phase id. The `<= 0` guard also
  // rejects pathological leading-slash strings.
  const tracks = result.tracks ?? [];

  for (const track of tracks) {
    for (const s of track.scenarios) {
      const sepIdx = typeof s.scenario === 'string' ? s.scenario.indexOf('/') : -1;
      if (sepIdx <= 0) continue; // skip legacy bare-name scenarios (no longer emitted by storyboard-driven comply())
      const sbId = s.scenario.slice(0, sepIdx);
      let agg = perStoryboard.get(sbId);
      if (!agg) {
        agg = {
          stepsPassed: 0,
          stepsTotal: 0,
          stepLessPhasesPassed: 0,
          stepLessPhasesTotal: 0,
          controllerSkipped: 0,
        };
        perStoryboard.set(sbId, agg);
      }

      // Roll per-step results up from the phase. Some SDK paths emit a phase
      // without a `steps` array (e.g. resource-resolution failures); we then
      // fall back to phase-level counts for that phase so mixed runs do not
      // discard resource-resolution failures when other phases have steps.
      if (!Array.isArray(s.steps) || s.steps.length === 0) {
        agg.stepLessPhasesTotal++;
        if (s.overall_passed) agg.stepLessPhasesPassed++;
        continue;
      }
      for (const step of s.steps) {
        if (step.skipped) {
          if (branchSkipReasons.has(step.skip_reason ?? '')) {
            continue;
          }
          if (isControllerSkip(step)) {
            agg.controllerSkipped++;
            continue;
          }
          agg.stepsTotal++;
          continue;
        }
        agg.stepsTotal++;
        if (step.passed) agg.stepsPassed++;
      }
    }
  }

  // Decide which storyboard ids to emit entries for.
  const hasExplicitIds = !!storyboardIds && storyboardIds.length > 0;
  const toEmit = hasExplicitIds ? storyboardIds! : Array.from(perStoryboard.keys());

  const entries: StoryboardStatusEntry[] = [];
  for (const sbId of toEmit) {
    const agg = perStoryboard.get(sbId);
    if (!agg) {
      // Explicit id requested but the runner didn't produce data for it.
      if (hasExplicitIds) {
        entries.push({ storyboard_id: sbId, status: 'untested', steps_passed: 0, steps_total: 0 });
      }
      continue;
    }

    const passed = agg.stepsPassed + agg.stepLessPhasesPassed;
    const executableTotal = agg.stepsTotal + agg.stepLessPhasesTotal;
    // Controller-only gaps are selected coverage gaps, not failed seller
    // assertions. Keep them visible via tracks_json.has_coverage_gap_skip,
    // but do not put them in the storyboard pass denominator. Otherwise a
    // storyboard like stale_response_advisory becomes partial even though its
    // only executable non-controller phase passed.
    const total = executableTotal;

    let status: StoryboardStatusEntry['status'];
    if (total === 0) {
      status = 'untested';
    } else if (passed === total) {
      status = 'passing';
    } else if (passed === 0) {
      status = 'failing';
    } else {
      status = 'partial';
    }

    entries.push({
      storyboard_id: sbId,
      status,
      steps_passed: passed,
      steps_total: total,
    });
  }

  return entries;
}

// ── Verification Status Derivation ───────────────────────────────

import { isStableSpecialism } from '../../services/adcp-taxonomy.js';
import type { BadgeRole } from '../../db/compliance-db.js';

/**
 * AAO Verified badge roles map to AdCP protocols that have shipped
 * specialism storyboards and a corresponding DB CHECK constraint
 * (see migration 453_agent_verification_badges.sql). Newer protocols
 * like `measurement` will be added once their storyboards ship.
 */
export type { BadgeRole };

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
    has_coverage_gap_skip: trackHasCoverageGapSkip(t),
  }));

  const { overall_status, tracks_passed, tracks_failed, tracks_partial } = effectiveRunStatus(result);

  return {
    agent_url: agentUrl,
    requested_compliance_target: (result as ComplianceResult & { requested_compliance_target?: string })
      .requested_compliance_target ?? null,
    adcp_version: result.adcp_version ?? null,
    lifecycle_stage: lifecycleStage,
    overall_status,
    headline: result.summary.headline,
    total_duration_ms: result.total_duration_ms,
    tracks_json: tracksJson,
    tracks_passed,
    tracks_failed,
    tracks_skipped: result.summary.tracks_skipped,
    tracks_partial,
    agent_profile_json: result.agent_profile,
    observations_json: result.observations,
    triggered_by: triggeredBy,
    storyboard_statuses: deriveStoryboardStatuses(result, storyboardIds),
    replace_storyboard_statuses: !storyboardIds?.length,
    step_diagnostics: extractFailingStepDiagnostics(result),
    // Forward-compat: notices are an optional field in the runner output
    // contract (run_summary.notices). Unknown codes/severities are stored
    // verbatim — do not filter or validate the values here.
    notices_json: (result.summary as any).notices ?? null,
  };
}

// ── Step diagnostics extraction (adcp#4738) ─────────────────────────

/**
 * Per-step JSON payload cap. AdCP wire requests/responses are typically a
 * few KB; the cap exists to bound the long tail (paginated lists with
 * hundreds of entries, embedded base64 assets in error echos). 64KB lets a
 * realistic page-of-160-creatives response through while preventing a
 * pathological body from bloating the run insert. Truncated payloads are
 * replaced with a marker object so downstream JSONB readers don't choke.
 */
const STEP_DIAGNOSTIC_PAYLOAD_BYTE_CAP = 64 * 1024;

/**
 * Headers we keep on response captures. AdCP MCP responses don't normally
 * carry `Set-Cookie` or `Authorization` echoes, but defense-in-depth — the
 * runner doesn't promise it'll never populate them, and once a JSONB blob
 * lands in the DB we lose the ability to retroactively redact it.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'date',
  'server',
  'x-request-id',
  'x-trace-id',
]);

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (ALLOWED_RESPONSE_HEADERS.has(lower)) out[lower] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SENSITIVE_DIAGNOSTIC_KEY_PATTERN = /(authorization|token|secret|password|cookie|credential|api[_-]?key|access[_-]?key|refresh[_-]?token)/i;
const SENSITIVE_DIAGNOSTIC_VALUE_PATTERN = /\b(?:sk_(?:live|test)_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;
const SENSITIVE_DIAGNOSTIC_TEXT_PATTERN = /(?:\bbearer\s+\S+|\b(?:authorization|cookie|set-cookie|session|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|credential)\b\s*[:=]\s*\S+)/i;

function redactForDiagnostics(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return SENSITIVE_DIAGNOSTIC_VALUE_PATTERN.test(value) || SENSITIVE_DIAGNOSTIC_TEXT_PATTERN.test(value)
      ? '[redacted]'
      : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactForDiagnostics(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactForDiagnostics(child, depth + 1);
  }
  return out;
}

function capPayload(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { __truncated: true, reason: 'serialize_failed' };
  }
  if (serialized.length <= STEP_DIAGNOSTIC_PAYLOAD_BYTE_CAP) return value;
  return {
    __truncated: true,
    reason: 'size_cap',
    original_bytes: serialized.length,
    cap_bytes: STEP_DIAGNOSTIC_PAYLOAD_BYTE_CAP,
  };
}

function capDiagnosticPayload(value: unknown): unknown {
  return capPayload(redactForDiagnostics(value));
}

function redactDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactForDiagnostics(value);
  const text = typeof redacted === 'string' ? redacted : '[redacted]';
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function stripValidationRequestResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { request: _request, response: _response, ...rest } = value as Record<string, unknown>;
  return rest;
}

/**
 * Walk a ComplianceResult and return one StepDiagnosticEntry per failing
 * (non-skipped) step. Raw storyboard results populate `request` and
 * `response_record` on every step where the call reached the wire. Full
 * compliance results may be flattened by the SDK into TestStepResult shape;
 * in that case we merge in `ComplianceResult.failures[]` attribution and
 * persist the response preview/first failed validation summary that survived
 * flattening instead of dropping the row.
 *
 * `failed_validations_jsonb` only includes validations the runner marked
 * not-passed, or the SDK's first failed-validation summary when the raw
 * validations array is no longer present.
 */
export function extractFailingStepDiagnostics(result: ComplianceResult): StepDiagnosticEntry[] {
  const out: StepDiagnosticEntry[] = [];
  const tracks = result.tracks ?? [];
  const failureLookup = buildFailureLookup(result);
  for (const track of tracks) {
    for (const phase of track.scenarios) {
      const steps = (phase as { steps?: any[] }).steps ?? [];
      for (const step of steps) {
        if (step.passed) continue;
        if (step.skipped === true) continue;

        const matchedFailure = takeMatchingFailure(failureLookup, track.track, phase.scenario, step);
        const storyboardId = firstString(
          step.storyboard_id,
          matchedFailure?.storyboard_id,
          scenarioStoryboardIdForFallback(phase.scenario),
        );
        const phaseId = firstString(
          step.phase_id,
          phaseIdFromScenario(phase.scenario, storyboardId),
          'unknown',
        );
        const stepId = firstString(step.step_id, matchedFailure?.step_id, slugifyStepId(step.step));
        const task = firstString(step.task, matchedFailure?.task, 'unknown');
        if (!storyboardId || !phaseId || !stepId || !task) continue;

        const req = step.request as { url?: string; payload?: unknown } | undefined;
        const resp = step.response_record as
          | { status?: number; headers?: Record<string, string>; payload?: unknown }
          | undefined;
        const responsePayload = resp && Object.prototype.hasOwnProperty.call(resp, 'payload')
          ? resp.payload
          : step.observation_data;
        const extraction = step.extraction as { path?: string; note?: string } | undefined;
        const failedValidations = failedValidationsForStep(step, matchedFailure);

        out.push({
          storyboard_id: storyboardId,
          phase_id: phaseId,
          step_id: stepId,
          task,
          step_passed: false,
          duration_ms: typeof step.duration_ms === 'number' ? step.duration_ms : undefined,
          request_url: req?.url,
          request_jsonb: capDiagnosticPayload(req?.payload),
          response_status: typeof resp?.status === 'number' ? resp.status : undefined,
          response_headers_jsonb: sanitizeHeaders(resp?.headers),
          response_jsonb: capDiagnosticPayload(responsePayload),
          extraction_path: extraction?.path,
          extraction_note: extraction?.note,
          error_text: redactDiagnosticText(step.error),
          adcp_error_jsonb: capDiagnosticPayload(step.adcp_error),
          failed_validations_jsonb: failedValidations && failedValidations.length > 0
            ? capDiagnosticPayload(failedValidations.map(stripValidationRequestResponse))
            : undefined,
          served_by_agent_url: typeof step.agent_url === 'string' ? step.agent_url : undefined,
        });
      }
    }
  }
  return out;
}

type ComplianceFailureSummary = NonNullable<ComplianceResult['failures']>[number];

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function slugifyStepId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug || undefined;
}

function phaseIdFromScenario(scenario: unknown, storyboardId: string | undefined): string | undefined {
  if (typeof scenario !== 'string' || !storyboardId) return undefined;
  const prefix = `${storyboardId}/`;
  if (!scenario.startsWith(prefix)) return undefined;
  const phaseId = scenario.slice(prefix.length);
  return phaseId || undefined;
}

function scenarioStoryboardIdForFallback(scenario: unknown): string | undefined {
  if (typeof scenario !== 'string' || scenario.length === 0) return undefined;
  const sepIdx = scenario.lastIndexOf('/');
  if (sepIdx < 0) return undefined;
  return scenario.slice(0, sepIdx) || undefined;
}

function failureMatchesScenario(failure: ComplianceFailureSummary, scenario: unknown): boolean {
  if (typeof scenario !== 'string' || scenario.length === 0) return true;
  return scenario === failure.storyboard_id || scenario.startsWith(`${failure.storyboard_id}/`);
}

function failureKey(track: unknown, stepTitle: unknown, task: unknown, error: unknown): string {
  return [
    typeof track === 'string' ? track : '',
    typeof stepTitle === 'string' ? stepTitle : '',
    typeof task === 'string' ? task : '',
    typeof error === 'string' ? error : '',
  ].join('\u001f');
}

function buildFailureLookup(result: ComplianceResult): Map<string, ComplianceFailureSummary[]> {
  const lookup = new Map<string, ComplianceFailureSummary[]>();
  for (const failure of result.failures ?? []) {
    addFailureLookupEntry(lookup, failureKey(failure.track, failure.step_title, failure.task, failure.error), failure);
    addFailureLookupEntry(lookup, failureKey(failure.track, failure.step_title, failure.task, undefined), failure);
    addFailureLookupEntry(lookup, failureKey(failure.track, failure.step_title, undefined, failure.error), failure);
  }
  return lookup;
}

function addFailureLookupEntry(
  lookup: Map<string, ComplianceFailureSummary[]>,
  key: string,
  failure: ComplianceFailureSummary,
): void {
  const bucket = lookup.get(key) ?? [];
  bucket.push(failure);
  lookup.set(key, bucket);
}

function takeMatchingFailure(
  lookup: Map<string, ComplianceFailureSummary[]>,
  track: unknown,
  scenario: unknown,
  step: { step?: unknown; task?: unknown; error?: unknown },
): ComplianceFailureSummary | undefined {
  const exact = lookup.get(failureKey(track, step.step, step.task, step.error));
  const exactMatch = takeScenarioCompatibleFailure(exact, scenario);
  if (exactMatch) return consumeFailure(lookup, exactMatch);

  const withoutError = lookup.get(failureKey(track, step.step, step.task, undefined));
  const withoutErrorMatch = takeScenarioCompatibleFailure(withoutError, scenario);
  if (withoutErrorMatch) return consumeFailure(lookup, withoutErrorMatch);

  const withoutTask = lookup.get(failureKey(track, step.step, undefined, step.error));
  const withoutTaskMatch = takeScenarioCompatibleFailure(withoutTask, scenario);
  if (withoutTaskMatch) return consumeFailure(lookup, withoutTaskMatch);

  return undefined;
}

function takeScenarioCompatibleFailure(
  failures: ComplianceFailureSummary[] | undefined,
  scenario: unknown,
): ComplianceFailureSummary | undefined {
  if (!failures?.length) return undefined;
  return failures.find(failure => failureMatchesScenario(failure, scenario));
}

function consumeFailure(
  lookup: Map<string, ComplianceFailureSummary[]>,
  failure: ComplianceFailureSummary | undefined,
): ComplianceFailureSummary | undefined {
  if (!failure) return undefined;
  for (const [key, bucket] of lookup) {
    const filtered = bucket.filter(candidate => candidate !== failure);
    if (filtered.length === 0) {
      lookup.delete(key);
    } else if (filtered.length !== bucket.length) {
      lookup.set(key, filtered);
    }
  }
  return failure;
}

function failedValidationsForStep(
  step: { validations?: unknown },
  matchedFailure?: ComplianceFailureSummary,
): unknown[] | undefined {
  if (Array.isArray(step.validations)) {
    return step.validations.filter((v: { passed?: boolean }) => v?.passed === false);
  }
  if (!matchedFailure?.validation) return undefined;
  return [{
    ...matchedFailure.validation,
    passed: false,
  }];
}
