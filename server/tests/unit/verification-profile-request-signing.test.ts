import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  buildComplianceBundleResults,
  runStoryboard,
  type ComplianceBundleResult,
  type ComplianceResult,
  type StoryboardResult,
  type TestResult,
  type TrackResult,
} from '@adcp/sdk/testing';
import { getCachedComplianceStoryboardById } from '../../src/compliance/storyboard-cache.js';
import { hostedComplianceOptions, hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';
import { deriveVerificationProfileRoleAssessments } from '../../src/services/verification-profile-assessment.js';

// The SDK projects raw storyboard results into track scenarios with a mapper it
// does not export; resolve it from the public testing entry, as hosted runs do.
const require = createRequire(import.meta.url);
const { mapStoryboardResultsToTrackResult } = require(join(
  dirname(require.resolve('@adcp/sdk/testing')), 'compliance/storyboard-tracks.js',
)) as { mapStoryboardResultsToTrackResult: (track: string, results: StoryboardResult[], profile: unknown) => TrackResult };

// #8534: hosted heartbeat on the 3.1.29 bundle for a media-buy 3.1 seller. The
// SDK grades declined capability gates not applicable only from 3.2.
const ISSUE_RELEASE = '3.1.29';
const SDK_CAPABILITY_ROLLUP_RELEASE = '3.2.10';
const RELEASE_LINES: Readonly<Record<string, string>> = { [ISSUE_RELEASE]: '3.1', [SDK_CAPABILITY_ROLLUP_RELEASE]: '3.2' };
const AGENT_URL = 'https://seller.example.test/mcp';
const TESTED_AT = '2026-10-27T11:54:00Z';
const SPECIALISM_STEPS = 6;
// Loading two released catalogs from disk outlasts the default hook budget.
const CATALOG_LOAD_TIMEOUT_MS = 120_000;

const ISSUE_PROFILE = {
  name: 'Non-guaranteed CTV seller',
  tools: [
    'get_adcp_capabilities', 'get_products', 'create_media_buy', 'update_media_buy', 'get_media_buys',
    'get_media_buy_delivery', 'list_creative_formats', 'sync_creatives', 'list_creatives',
    'sync_accounts', 'list_accounts', 'comply_test_controller',
  ],
  supported_protocols: ['media_buy'],
  specialisms: ['sales-non-guaranteed'],
  adcp_major_versions: [3],
  // No wholesale feed, request signing, audience targeting or reach metrics.
  raw_capabilities: {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: { supported_billing: ['operator'] },
  },
};

type BundleSpec = readonly [bundleId: string, storyboardId: string];

// Rows of the #8534 table, as bundle id and storyboard id.
const UNDECLARED_SURFACE_BUNDLES: readonly BundleSpec[] = [
  ['error-compliance-signals', 'error_compliance_signals'],
  ['schema-validation-signals', 'schema_validation_signals'],
  ['get-signals-pagination-integrity', 'get_signals_pagination_integrity'],
  ['collection-lists-pagination-integrity', 'pagination_integrity_collection_lists'],
  ['property-lists-pagination-integrity', 'pagination_integrity_property_lists'],
  ['content-standards-pagination-integrity', 'pagination_integrity_content_standards'],
];
const DECLINED_CAPABILITY_BUNDLES: readonly BundleSpec[] = [
  ['wholesale-feed-products', 'wholesale_feed_products'],
  ['wholesale-feed-product-webhooks', 'wholesale_feed_product_webhooks'],
  ['wholesale-feed-bulk-webhooks', 'wholesale_feed_bulk_webhooks'],
  ['wholesale-feed-signal-webhooks', 'wholesale_feed_signal_webhooks'],
  ['wholesale-feed-signals', 'wholesale_feed_signals'],
];
const SIGNING_BUNDLE: BundleSpec = ['signed-requests', 'signed_requests'];
// Runner-side gaps: no webhook receiver, no replay receiver.
const RUNNER_GAP_BUNDLES: readonly BundleSpec[] = [
  ['webhook-emission', 'webhook_emission'],
  ['webhook-receiver-envelope', 'webhook_receiver_envelope'],
];
const IDEMPOTENCY_BUNDLE: BundleSpec = ['idempotency', 'idempotency'];
const PROTOCOL_BASELINE = 'media_buy_seller';
const PROTOCOL_GATED_SCENARIOS = ['media_buy_seller/audience_buy_flow', 'media_buy_seller/reach_buy_flow'];
const GATED_STORYBOARDS = [
  ...DECLINED_CAPABILITY_BUNDLES.map(([, id]) => id),
  SIGNING_BUNDLE[1],
  ...RUNNER_GAP_BUNDLES.map(([, id]) => id),
  ...PROTOCOL_GATED_SCENARIOS,
];

interface ReleaseFixture {
  runs: Map<string, StoryboardResult>;
  sdkStatus: Map<string, ComplianceBundleResult['status']>;
  protocolStatus: ComplianceBundleResult['status'];
}
const fixtures = new Map<string, ReleaseFixture>();

function storyboardFor(version: string, id: string) {
  const storyboard = getCachedComplianceStoryboardById(id, hostedComplianceOptions(hostedComplianceTarget(version)));
  if (!storyboard) throw new Error(`${id} is not in the ${version} catalog`);
  return storyboard;
}

/** Runs one storyboard through the real runner with a client that must never be called. */
async function runGate(version: string, id: string): Promise<StoryboardResult> {
  const dispatched: string[] = [];
  const client = new Proxy({ resetContext() {} }, {
    get(target, key) {
      if (key === 'resetContext') return target.resetContext;
      if (key === 'then') return undefined;
      return () => {
        dispatched.push(String(key));
        throw new Error('A gated storyboard must never reach the agent');
      };
    },
  });
  const result = await runStoryboard(AGENT_URL, storyboardFor(version, id), {
    ...hostedComplianceOptions(hostedComplianceTarget(version)),
    _profile: { ...ISSUE_PROFILE, adcp_supported_versions: [RELEASE_LINES[version]] },
    agentTools: ISSUE_PROFILE.tools,
    _client: client,
  } as Parameters<typeof runStoryboard>[2]);
  expect(dispatched, id).toEqual([]);
  return result;
}

/** A clean pass for the protocol baseline, which cannot run offline. */
function passingBaseline(): StoryboardResult {
  return {
    storyboard_id: PROTOCOL_BASELINE,
    storyboard_title: 'Media buy seller',
    agent_url: AGENT_URL,
    overall_passed: true,
    phases: [{
      phase_id: 'product_discovery',
      phase_title: 'Product discovery',
      passed: true,
      duration_ms: 0,
      steps: [{
        storyboard_id: PROTOCOL_BASELINE,
        step_id: 'get_products',
        phase_id: 'product_discovery',
        title: 'Discover products',
        task: 'get_products',
        passed: true,
        duration_ms: 0,
        validations: [],
        context: {},
        extraction: { path: 'none' },
      }],
    }],
    context: {},
    total_duration_ms: 0,
    passed_count: 1,
    failed_count: 0,
    skipped_count: 0,
    tested_at: TESTED_AT,
    notices: [],
  } as StoryboardResult;
}

async function buildFixture(version: string): Promise<ReleaseFixture> {
  const runs = new Map<string, StoryboardResult>();
  for (const id of GATED_STORYBOARDS) runs.set(id, await runGate(version, id));
  const sdkStatus = new Map(GATED_STORYBOARDS.map(id => {
    const [bundle] = buildComplianceBundleResults([{
      ref: { kind: 'universal', id, path: '/unused' },
      storyboards: [storyboardFor(version, id)],
    }], [runs.get(id)!]);
    return [id, bundle.status] as const;
  }));
  const protocolIds = [PROTOCOL_BASELINE, ...PROTOCOL_GATED_SCENARIOS];
  const [protocol] = buildComplianceBundleResults([{
    ref: { kind: 'protocol', id: 'media-buy', path: '/unused' },
    storyboards: protocolIds.map(id => storyboardFor(version, id)),
  }], [passingBaseline(), ...PROTOCOL_GATED_SCENARIOS.map(id => runs.get(id)!)]);
  return { runs, sdkStatus, protocolStatus: protocol.status };
}

beforeAll(async () => {
  for (const version of [ISSUE_RELEASE, SDK_CAPABILITY_ROLLUP_RELEASE]) fixtures.set(version, await buildFixture(version));
}, CATALOG_LOAD_TIMEOUT_MS);

function idempotencyScenario(): TestResult {
  return {
    agent_url: AGENT_URL,
    scenario: 'idempotency/rate_limit_replay_invariant',
    overall_passed: true,
    steps: [{
      step: 'Rate-limit replay invariant',
      step_id: 'rate_limit_replay_invariant',
      task: 'expect_rate_limit_not_replayed',
      passed: true,
      skipped: true,
      skip_reason: 'missing_test_kit_contract',
      duration_ms: 0,
    }],
    summary: 'Test-kit contract out of scope',
    total_duration_ms: 0,
    tested_at: TESTED_AT,
  } as TestResult;
}

/** The #8534 run: every executed check passes, the rest is set aside or gapped. */
function issueRun(options: { release?: string; runnerGapsClosed?: boolean } = {}): ComplianceResult {
  const release = options.release ?? ISSUE_RELEASE;
  const fixture = fixtures.get(release)!;
  const runnerGapIds = new Set(RUNNER_GAP_BUNDLES.map(([, id]) => id));
  const ranGates = GATED_STORYBOARDS.filter(id => !options.runnerGapsClosed || !runnerGapIds.has(id));
  const track = mapStoryboardResultsToTrackResult('core', ranGates.map(id => fixture.runs.get(id)!), ISSUE_PROFILE);
  if (!options.runnerGapsClosed) track.scenarios.push(idempotencyScenario());
  const universal = ([bundleId, storyboardId]: BundleSpec, status: ComplianceBundleResult['status']): ComplianceBundleResult =>
    ({ kind: 'universal', id: bundleId, storyboard_ids: [storyboardId], status });
  const sdkGraded = (spec: BundleSpec) => universal(spec, fixture.sdkStatus.get(spec[1])!);
  return {
    agent_url: AGENT_URL,
    adcp_version: release,
    completeness: 'complete',
    agent_profile: { ...ISSUE_PROFILE, adcp_supported_versions: [RELEASE_LINES[release]] },
    overall_status: 'passing',
    tracks: [track],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 1, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 0, tracks_silent: 0,
      headline: 'All tracks pass',
    },
    observations: [],
    storyboards_executed: ['capability_discovery', ...ranGates, IDEMPOTENCY_BUNDLE[1], PROTOCOL_BASELINE, 'sales_non_guaranteed'],
    storyboards_missing_tools: UNDECLARED_SURFACE_BUNDLES.map(([, id]) => id),
    bundle_results: [
      { kind: 'universal', id: 'capability-discovery', storyboard_ids: ['capability_discovery'], status: 'passing' },
      ...UNDECLARED_SURFACE_BUNDLES.map(spec => universal(spec, 'partial')),
      ...DECLINED_CAPABILITY_BUNDLES.map(sdkGraded),
      sdkGraded(SIGNING_BUNDLE),
      ...RUNNER_GAP_BUNDLES.map(spec => (options.runnerGapsClosed ? universal(spec, 'passing') : sdkGraded(spec))),
      universal(IDEMPOTENCY_BUNDLE, options.runnerGapsClosed ? 'passing' : 'partial'),
      {
        kind: 'protocol',
        id: 'media-buy',
        storyboard_ids: [PROTOCOL_BASELINE, ...PROTOCOL_GATED_SCENARIOS],
        status: fixture.protocolStatus,
      },
      { kind: 'specialism', id: 'sales-non-guaranteed', storyboard_ids: ['sales_non_guaranteed'], status: 'passing' },
    ],
    tested_at: TESTED_AT,
    total_duration_ms: 0,
    notices: [],
  } as ComplianceResult;
}

function assessments(run: ComplianceResult) {
  return deriveVerificationProfileRoleAssessments({
    result: run,
    lifecycleStage: 'production',
    requestedComplianceTarget: RELEASE_LINES[run.adcp_version!],
    storyboardStatuses: [{
      storyboard_id: 'sales_non_guaranteed',
      status: 'passing',
      steps_passed: SPECIALISM_STEPS,
      steps_total: SPECIALISM_STEPS,
    }],
  });
}

function strictSpec(run: ComplianceResult) {
  return assessments(run).find(assessment => assessment.grading_profile === 'spec')!;
}

function setAside(run: ComplianceResult): string[] {
  return strictSpec(run).evidence.not_applicable_universal_bundle_ids as string[];
}

function scenariosOf(run: ComplianceResult): TestResult[] {
  return run.tracks[0].scenarios;
}

function gateStep(run: ComplianceResult, storyboardId: string) {
  return scenariosOf(run).find(scenario => scenario.scenario.startsWith(`${storyboardId}/`))!.steps![0];
}

const [SIGNING_BUNDLE_ID, SIGNING_STORYBOARD] = SIGNING_BUNDLE;

describe('Strict Spec for an agent that does not advertise request signing (#8534)', { timeout: CATALOG_LOAD_TIMEOUT_MS }, () => {
  it('sets aside signed_requests on the issue run and keeps every other gap incomplete', () => {
    const fixture = fixtures.get(ISSUE_RELEASE)!;
    // The SDK grades the unmet signer partial on every release.
    expect(fixture.sdkStatus.get(SIGNING_STORYBOARD)).toBe('partial');
    // Deliberate tripwire: declined 3.1 capability gates stay partial until the
    // SDK applies its rollup from 3.1.24 (adcontextprotocol/adcp-client#3699).
    // On that SDK bump
    // this fails, and the wholesale and protocol bundles leave the incomplete
    // list below.
    expect(fixture.sdkStatus.get(DECLINED_CAPABILITY_BUNDLES[0][1])).toBe('partial');
    expect(fixture.protocolStatus).toBe('partial');

    const assessment = strictSpec(issueRun());
    expect(assessment.status).toBe('partial');
    expect(assessment.evidence.failing_bundle_count).toBe(0);
    expect(assessment.evidence.not_applicable_universal_bundle_ids).toEqual([
      ...UNDECLARED_SURFACE_BUNDLES.map(([bundleId]) => bundleId),
      SIGNING_BUNDLE_ID,
    ]);
    expect(assessment.evidence.incomplete_bundle_ids).toEqual([
      ...DECLINED_CAPABILITY_BUNDLES.map(([bundleId]) => `universal:${bundleId}`),
      'universal:webhook-emission',
      'universal:webhook-receiver-envelope',
      'universal:idempotency',
      'protocol:media-buy',
    ]);
  });

  it('reaches Strict on a release the SDK grades declined capabilities on, once runner gaps close', () => {
    const fixture = fixtures.get(SDK_CAPABILITY_ROLLUP_RELEASE)!;
    expect(fixture.sdkStatus.get(SIGNING_STORYBOARD)).toBe('partial');
    expect(fixture.sdkStatus.get(DECLINED_CAPABILITY_BUNDLES[0][1])).toBe('not_applicable');
    expect(fixture.protocolStatus).toBe('passing');

    const profiles = assessments(issueRun({ release: SDK_CAPABILITY_ROLLUP_RELEASE, runnerGapsClosed: true }));
    expect(profiles.find(assessment => assessment.grading_profile === 'legacy')?.status).toBe('passing');
    const assessment = profiles.find(assessment => assessment.grading_profile === 'spec')!;
    expect(assessment.status).toBe('passing');
    expect(assessment.evidence.incomplete_bundle_ids).toEqual([]);
  });

  it.each<[string, (run: ComplianceResult) => void]>([
    ['the agent advertises request signing', run => {
      run.agent_profile = {
        ...run.agent_profile,
        raw_capabilities: { ...ISSUE_PROFILE.raw_capabilities, request_signing: { supported: true } },
      };
    }],
    ['the raw capabilities are unavailable', run => {
      run.agent_profile = { ...run.agent_profile, raw_capabilities: undefined };
    }],
    ['the unmet requirement is not the signer', run => {
      gateStep(run, SIGNING_STORYBOARD).requirement = 'webhook_replay_receiver';
    }],
    ['the runner also reported the storyboard as missing tools', run => {
      run.storyboards_missing_tools = [...run.storyboards_missing_tools!, SIGNING_STORYBOARD];
    }],
    ['a failure is recorded for the storyboard', run => {
      run.failures = [{
        track: 'security_transport',
        storyboard_id: SIGNING_STORYBOARD,
        step_id: 'detached',
        step_title: 'Detached assertion',
        task: 'get_adcp_capabilities',
        fix_command: 'npx adcp test',
      }];
    }],
    ['a storyboard-scoped assertion failed', run => {
      run.observations = [{
        category: 'error_compliance',
        severity: 'error',
        track: 'security_transport',
        message: 'A storyboard-scoped compliance assertion failed.',
        source: { kind: 'storyboard', code: 'storyboard-assertion-failed', storyboard_id: SIGNING_STORYBOARD },
      } as ComplianceResult['observations'][number]];
    }],
    ['a step ran beside the unmet-signer row', run => {
      scenariosOf(run).push({
        ...scenariosOf(run)[0],
        scenario: `${SIGNING_STORYBOARD}/capability_discovery`,
        steps: [{ step: 'Discovery', step_id: 'discovery', task: 'get_adcp_capabilities', passed: true, duration_ms: 1 }],
      } as TestResult);
    }],
    ['the row carries validations', run => {
      gateStep(run, SIGNING_STORYBOARD).validations = [{ check: 'field_present', passed: true }];
    }],
    ['the runner did not execute the storyboard', run => {
      run.storyboards_executed = run.storyboards_executed!.filter(id => id !== SIGNING_STORYBOARD);
    }],
  ])('keeps signed-requests incomplete when %s', (_label, mutate) => {
    expect(setAside(issueRun())).toContain(SIGNING_BUNDLE_ID);

    const run = issueRun();
    mutate(run);
    const assessment = strictSpec(run);
    expect(assessment.evidence.not_applicable_universal_bundle_ids).not.toContain(SIGNING_BUNDLE_ID);
    expect(assessment.status).not.toBe('passing');
  });

  it('sets aside an unmet request_signer only on signed_requests', () => {
    const [receiverBundle, receiverStoryboard] = RUNNER_GAP_BUNDLES[1];
    const run = issueRun();
    const row = gateStep(run, receiverStoryboard);
    row.step_id = 'requirement_unmet:request_signer';
    row.requirement = 'request_signer';

    const ids = setAside(run);
    expect(ids).toContain(SIGNING_BUNDLE_ID);
    expect(ids).not.toContain(receiverBundle);
  });
});
