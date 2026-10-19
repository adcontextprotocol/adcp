import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  parseStoryboard,
  runStoryboard,
  type ComplianceResult,
  type Storyboard,
  type StoryboardResult,
} from '@adcp/sdk/testing';
import {
  complianceResultToDbInput,
  deriveStoryboardStatuses,
} from '../../server/src/addie/services/compliance-testing.js';

// Hosted classification must use the exact edited metadata, rather than the
// immutable released cache whose defect this patch fixes. Only that cache
// lookup is mocked; execution and hosted grading are the published runner and
// the production adapters.
const pinned = vi.hoisted(() => ({ storyboards: new Map<string, unknown>() }));
vi.mock('@adcp/sdk/testing', async importOriginal => ({
  ...await importOriginal<typeof import('@adcp/sdk/testing')>(),
  getComplianceStoryboardById: (id: string) => pinned.storyboards.get(id),
}));

const require = createRequire(import.meta.url);
const { buildTo } = require('../../scripts/build-compliance.cjs');
const { canonicalizePublishedSchemaUris } = require('../../scripts/build-schemas.cjs');
const { version } = require('../../package.json');
const sourceDir = path.resolve('static/compliance/source');
const url = 'https://agent.example/mcp';
let bundleDir: string;
let schemaDir: string;
let loadPublished: typeof import('@adcp/sdk/testing').getComplianceStoryboardById;

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'authored-tool-gates-'));
  buildTo(bundleDir, version, sourceDir);
  schemaDir = mkdtempSync(path.join(tmpdir(), 'authored-tool-schemas-'));
  cpSync(path.resolve('static/schemas/source'), schemaDir, { recursive: true });
  // The SDK requires published schema IDs. Use the publication URI transform
  // on a disposable source snapshot; no checked-in release artifacts change.
  for (const file of readdirSync(schemaDir, { recursive: true }) as string[]) {
    if (!file.endsWith('.json')) continue;
    const location = path.join(schemaDir, file);
    const schema = JSON.parse(readFileSync(location, 'utf8'));
    writeFileSync(location, JSON.stringify(canonicalizePublishedSchemaUris(schema, version)));
  }
  loadPublished = (await vi.importActual<typeof import('@adcp/sdk/testing')>('@adcp/sdk/testing'))
    .getComplianceStoryboardById;
});
afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(schemaDir, { recursive: true, force: true });
});

function load(name: string, surface: string): Storyboard {
  const file = name === 'sales_dooh' ? 'specialisms/sales-dooh/index.yaml'
    : `protocols/media-buy/scenarios/${name}.yaml`;
  const source: Storyboard = parseStoryboard(readFileSync(path.join(sourceDir, file), 'utf8'));
  const storyboard = surface === 'source' ? source
    : loadPublished(source.id, { complianceDir: bundleDir, version });
  expect(storyboard).toBeDefined();
  pinned.storyboards.set(source.id, storyboard);
  // Omit the loader's wire-version setting for offline injected clients. All
  // authored gates, requests, dependencies, captures and validations remain.
  return { ...storyboard!, adcp_version: undefined };
}

const allTools = [
  'get_adcp_capabilities', 'comply_test_controller', 'sync_accounts', 'sync_event_sources',
  'get_products', 'list_products', 'create_media_buy', 'update_media_buy', 'control_media_buy',
  'get_media_buys', 'get_media_buy_delivery', 'report_usage', 'request_proposals',
  'refine_proposals', 'decline_proposals', 'accept_proposal', 'buy_products', 'sync_creatives', 'validate_input',
];
function capabilities() {
  return {
    supported_protocols: ['media_buy'],
    media_buy: {
      lifecycle_tools: ['list_products', 'request_proposals', 'refine_proposals', 'decline_proposals',
        'buy_products', 'accept_proposal', 'control_media_buy'],
      conversion_tracking: {}, frequency_capping: {}, aggregate_frequency_capping: {},
      availability_horizon: true,
      proposal_refinement: { supported_dimensions: ['alternatives', 'criteria', 'product_changes'] },
    },
  };
}

type Call = { task: string; request: Record<string, unknown> };
type Respond = (task: string, request: Record<string, unknown>) => unknown;
function rejectingClient(calls: Call[], respond?: Respond) {
  const reject = (task: string, request: Record<string, unknown>) => {
    calls.push({ task, request });
    if (respond) return respond(task, request);
    throw new Error(`Advertised ${task} is broken`);
  };
  return new Proxy({ resetContext() {}, agent: { id: 'test-seller', agent_uri: url } }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      if (property === 'then' || property === 'getAdcpVersion') return undefined;
      if (property === 'executeTask') return (task: string, request: Record<string, unknown>) => reject(task, request);
      if (typeof property !== 'string') return undefined;
      return (request: Record<string, unknown>) => reject(property.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), request);
    },
  });
}

async function execute(storyboard: Storyboard, tools = allTools, raw = capabilities(), context = {}, respond?: Respond) {
  const calls: Call[] = [];
  const result = await runStoryboard(url, storyboard, {
    agentTools: tools,
    _profile: { tools, raw_capabilities: raw },
    _client: rejectingClient(calls, respond) as never,
    _serverAdcpVersion: version, schemaRoot: schemaDir,
    skip_controller_seeding: true,
    context,
  });
  for (const call of calls) expect(JSON.stringify(call.request)).not.toContain('$context.');
  return { result, calls };
}

function hosted(storyboard: Storyboard, result: StoryboardResult, tools: string[]) {
  const run = {
    agent_url: url, adcp_version: version, agent_profile: { tools },
    overall_status: 'failing',
    tracks: [{ track: 'media_buy', status: 'fail', duration_ms: 0, skipped_scenarios: [], observations: [],
      scenarios: result.phases.map(phase => ({
        scenario: `${storyboard.id}/${phase.phase_id}`, overall_passed: phase.passed,
        steps: phase.steps.map(step => ({ ...step, step: step.title })),
      })),
    }],
    tested_tracks: [], skipped_tracks: [], observations: [], notices: [],
    summary: { headline: 'Failed', tracks_passed: 0, tracks_failed: 1, tracks_partial: 0, tracks_skipped: 0 },
    total_duration_ms: 0, tested_at: '2026-10-16T00:00:00.000Z',
  } as unknown as ComplianceResult;
  return { statuses: deriveStoryboardStatuses(run), input: complianceResultToDbInput(run, url, 'production') };
}

function slice(storyboard: Storyboard, stepIds: string[]): Storyboard {
  const selected = new Set(stepIds);
  const phaseIds = new Set(storyboard.phases.filter(phase => phase.steps.some(step => selected.has(step.id)))
    .map(phase => phase.id));
  return { ...storyboard, phases: storyboard.phases.filter(phase => phaseIds.has(phase.id)).map(phase => ({
    ...phase,
    // Prior phases' successful state is supplied explicitly in context. Retain
    // every dependency among the selected authored steps.
    depends_on: phase.depends_on?.filter(id => phaseIds.has(id)),
    steps: phase.steps.filter(step => selected.has(step.id)),
  })) };
}

function doohResponder(storyboard: Storyboard, broken?: string): Respond {
  // Reuse the authored seller fixture so the success control validates the
  // entire product contract rather than hand-maintaining another DOOH offer.
  const product = { ...storyboard.fixtures!.products![0], pricing_options:
    storyboard.fixtures!.pricing_options!.map(price => {
      const result = { ...price };
      delete result.product_id;
      return result;
    }) };
  const metrics = {
    plays: 125, frequency: 2.5, reach_unit: 'custom',
    dooh_metrics: { loop_plays: 125, screens_used: 18, screen_time_seconds: 2500, sov_achieved: 0.25 },
  };
  return (task, request) => {
    if (task === broken) throw new Error(`Advertised ${task} is broken`);
    const context = request.context;
    switch (task) {
      case 'get_adcp_capabilities': return { success: true, data: {
        adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
        supported_protocols: ['media_buy'], specialisms: ['sales-dooh'],
        experimental_features: ['media_buy.product_identity'],
        media_buy: { portfolio: { publisher_domains: ['metro-media.example'], primary_channels: ['dooh'] } }, context,
      } };
      case 'get_products': return { success: true, data: { products: [], cache_scope: 'account', context } };
      case 'list_products': return { success: true, data: {
        outcome: 'listed', products: [product], feed_version: 'dooh-feed', cache_scope: 'account', context,
      } };
      case 'sync_creatives': return { success: true, data: {
        creatives: [{ creative_id: 'dooh_acme_portrait_1080x1920', action: 'created' }], context,
      } };
      case 'create_media_buy': {
        const packages = request.packages as Array<{ targeting_overlay?: unknown }>;
        if (packages[0].targeting_overlay) return { success: false, data: { errors: [{
          code: 'UNSUPPORTED_FEATURE', field: 'packages[0].targeting_overlay.frequency_cap',
          message: 'Product has no frequency-cap support',
        }], context } };
        return { success: true, data: {
          media_buy_id: 'dooh-buy', confirmed_at: null, revision: 1, packages: [{ package_id: 'dooh-package' }], context,
        } };
      }
      case 'comply_test_controller': return { success: true, data: {
        success: true, simulated: request.params, context,
      } };
      case 'get_media_buy_delivery': return { success: true, data: {
        reporting_period: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
        media_buy_deliveries: [{ media_buy_id: 'dooh-buy', status: 'active', totals: metrics,
          by_package: [{ package_id: 'dooh-package', spend: 5000, pricing_model: 'flat_rate', rate: 5000, currency: 'USD', ...metrics }],
        }], context,
      } };
      default: throw new Error(`Unexpected ${task}`);
    }
  };
}

const state = {
  account_id: 'account-1', media_buy_id: 'buy-1', media_buy_revision: 1, active_revision: 1,
  create_only_package_id: 'package-1', mutable_package_id: 'package-2',
  committed_proposal_id: 'proposal-1', committed_terms_digest: 'sha256:abc',
  feed_version: 'feed-1', pricing_version: 'price-1',
};
const wholeGates = [
  { name: 'revenue_share_pricing', tool: 'sync_event_sources', step: 'sync_event_sources' },
  { name: 'change_rights_state_projection', tool: 'control_media_buy', step: 'pause_with_negotiated_right' },
  { name: 'refine_frequency_cap_negotiation', tool: 'request_proposals', step: 'request_capped_proposals' },
];

describe.each(['source', 'published bundle'])('authored optional-tool applicability: %s', surface => {
  it.each(wholeGates)('$name excludes absent optional tools before any stateful work', async ({ name, tool }) => {
    const storyboard = load(name, surface);
    const tools = allTools.filter(candidate => candidate !== tool);
    const raw = capabilities();
    raw.media_buy.lifecycle_tools = raw.media_buy.lifecycle_tools.filter(candidate => candidate !== tool);
    if (tool === 'sync_event_sources') delete (raw.media_buy as Partial<typeof raw.media_buy>).conversion_tracking;
    const { result, calls } = await execute(storyboard, tools, raw);
    expect(calls).toEqual([]);
    expect(result.failed_count).toBe(0);
    expect(result.phases[0].steps[0].skip_reason).toBe('capability_unsupported');
    const graded = hosted(storyboard, result, tools);
    expect(graded.statuses).toEqual([{ storyboard_id: storyboard.id, status: 'untested', steps_passed: 0, steps_total: 0 }]);
    expect(graded.input.tracks_failed).toBe(0);
  });

  it.each(wholeGates)('$name fails an advertised broken optional tool', async ({ name, tool, step }) => {
    const storyboard = load(name, surface);
    const { result, calls } = await execute(slice(storyboard, [step]), allTools, capabilities(), state);
    expect(calls.map(call => call.task), JSON.stringify(result)).toEqual([tool]);
    expect(result.failed_count).toBe(1);
    const graded = hosted(storyboard, result, allTools);
    expect(graded.statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
    expect(graded.input.tracks_failed).toBe(1);
  });

  it.each([
    { name: 'frequency_cap_capability_updates', phases: ['inspect_update_actions', 'enforce_update_boundaries'], step: 'update_mutable_package' },
    { name: 'media_buy_frequency_cap_updates', phases: ['replace_root_cap', 'guard_and_clear'], step: 'replace_root_cap' },
  ])('$name skips optional control branches while retaining required setup', async ({ name, phases, step }) => {
    const storyboard = load(name, surface);
    const tools = allTools.filter(tool => tool !== 'control_media_buy');
    const raw = capabilities();
    raw.media_buy.lifecycle_tools = raw.media_buy.lifecycle_tools.filter(tool => tool !== 'control_media_buy');
    const branches = { ...storyboard, phases: storyboard.phases.filter(phase => phases.includes(phase.id)) };
    const skipped = await execute(branches, tools, raw);
    expect(skipped.calls).toEqual([]);
    expect(skipped.result.failed_count).toBe(0);
    expect(hosted(storyboard, skipped.result, tools).statuses[0]).toMatchObject({ status: 'untested', steps_total: 0 });

    const required = await execute(slice(storyboard, ['sync_account', 'sync_accounts']), tools, raw);
    expect(required.calls.map(call => call.task)).toEqual(['sync_accounts']);
    expect(hosted(storyboard, required.result, tools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });

    const broken = await execute(slice(storyboard, [step]), allTools, capabilities(), state);
    expect(broken.calls.map(call => call.task)).toEqual(['control_media_buy']);
    expect(hosted(storyboard, broken.result, allTools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it.each([
    ...wholeGates,
    { name: 'frequency_cap_capability_updates', tool: 'control_media_buy', step: 'update_mutable_package' },
    { name: 'media_buy_frequency_cap_updates', tool: 'control_media_buy', step: 'replace_root_cap' },
    { name: 'typed_proposal_negotiation', tool: 'accept_proposal', step: 'accept_proposal' },
    { name: 'availability_windows', tool: 'list_products', step: 'list_without_forecast' },
    { name: 'availability_windows', tool: 'buy_products', step: 'reject_booked_span' },
  ])('$name fails an omitted $tool when its capability promise remains active', async ({ name, tool, step }) => {
    const storyboard = load(name, surface);
    const tools = allTools.filter(candidate => candidate !== tool);
    const { result, calls } = await execute(slice(storyboard, [step]), tools, capabilities(), state);
    expect(calls).toEqual([]);
    expect(result.phases[0].steps[0].skip_reason).toBe('missing_tool');
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it('product coverage skips only the absent compact tool and keeps the legacy path mandatory', async () => {
    const storyboard = load('product_coverage_filters', surface);
    const tools = allTools.filter(tool => tool !== 'list_products');
    // required_tools is any-of: get_products/controller start this storyboard,
    // and the mandatory legacy path still produces a real failure.
    const { result, calls } = await execute(storyboard, tools);
    expect(calls.map(call => call.task)).toEqual(['get_products']);
    const compact = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'compact_country_and_metro');
    expect(compact?.skip_reason).toBe('missing_tool');
    const graded = hosted(storyboard, result, tools);
    expect(graded.statuses[0]).toMatchObject({ status: 'failing', steps_total: 1, failure_count: 1 });
  });

  it('product coverage fails a compact tool that is advertised but broken', async () => {
    const storyboard = load('product_coverage_filters', surface);
    const { result, calls } = await execute(slice(storyboard, ['compact_country_and_metro']));
    expect(calls.map(call => call.task)).toEqual(['list_products']);
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it('typed acceptance and its stateful descendants skip when acceptance is absent', async () => {
    const storyboard = load('typed_proposal_negotiation', surface);
    const focused = slice(storyboard, ['accept_proposal', 'revise_amendment', 'revise_cancellation']);
    const tools = allTools.filter(tool => tool !== 'accept_proposal');
    const raw = capabilities();
    raw.media_buy.lifecycle_tools = raw.media_buy.lifecycle_tools.filter(tool => tool !== 'accept_proposal');
    const { result, calls } = await execute(focused, tools, raw, state);
    expect(calls).toEqual([]);
    expect(result.failed_count).toBe(0);
    expect(result.phases.flatMap(phase => phase.steps).map(step => step.skip?.reason)).toEqual([
      'not_applicable', 'not_applicable', 'not_applicable',
    ]);
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'untested', steps_total: 0 });
  });

  it('typed acceptance remains mandatory once advertised and blocks its descendants on failure', async () => {
    const storyboard = load('typed_proposal_negotiation', surface);
    const focused = slice(storyboard, ['accept_proposal', 'revise_amendment', 'revise_cancellation']);
    const { result, calls } = await execute(focused, allTools, capabilities(), state);
    expect(calls.map(call => call.task)).toEqual(['accept_proposal']);
    expect(result.failed_count).toBe(1);
    expect(result.phases.slice(1).flatMap(phase => phase.steps).every(step => step.skip_reason === 'prerequisite_failed')).toBe(true);
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it('availability listing absence skips its conditional read and negative buys without unresolved tokens', async () => {
    const storyboard = load('availability_windows', surface);
    const focused = slice(storyboard, ['list_without_forecast', 'list_with_horizon', 'conditional_with_forecast', 'reject_booked_span', 'reject_below_minimum']);
    const tools = allTools.filter(tool => tool !== 'list_products');
    const raw = capabilities();
    raw.media_buy.lifecycle_tools = raw.media_buy.lifecycle_tools.filter(tool => tool !== 'list_products');
    // No feed_version/pricing_version seed: a dispatched negative probe could
    // otherwise pass because an unresolved token provoked a convenient error.
    const { result, calls } = await execute(focused, tools, raw);
    expect(calls).toEqual([]);
    expect(result.failed_count).toBe(0);
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'untested', steps_total: 0 });
  });

  it('availability rejects silent success on an advertised negative buy probe', async () => {
    const storyboard = load('availability_windows', surface);
    const focused = slice(storyboard, ['reject_booked_span']);
    const { result, calls } = await execute(focused, allTools, capabilities(), state, (_task, request) => ({
      success: true, data: { media_buy_id: 'incorrectly-created', context: request.context },
    }));
    expect(calls.map(call => call.task)).toEqual(['buy_products']);
    expect(result.phases[0].steps[0].validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'error_code', passed: false }),
    ]));
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it('availability fails an advertised broken listing and never dispatches descendant buys', async () => {
    const storyboard = load('availability_windows', surface);
    const focused = slice(storyboard, ['list_without_forecast', 'list_with_horizon', 'conditional_with_forecast', 'reject_booked_span', 'reject_below_minimum']);
    const { result, calls } = await execute(focused);
    // The independent flexible-window read can still execute. Conditional
    // reads and buys need the failed mirror's version tokens and must not.
    expect(calls.map(call => call.task)).toEqual(['list_products', 'list_products']);
    expect(result.failed_count).toBeGreaterThan(0);
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'failing' });
  });

  it.each(['frequency_cap_capability_updates', 'media_buy_frequency_cap_updates'])('%s never dispatches state-dependent negative probes after create failure', async name => {
    const storyboard = load(name, surface);
    const create = storyboard.phases.flatMap(phase => phase.steps).find(step => step.task === 'create_media_buy')!;
    const negativeIds = storyboard.phases.flatMap(phase => phase.steps).filter(step => step.expect_error).map(step => step.id);
    const focused = slice(storyboard, [create.id, ...negativeIds]);
    const { result, calls } = await execute(focused, allTools, capabilities(), state);
    expect(calls.map(call => call.task)).toEqual(['create_media_buy']);
    for (const step of result.phases.flatMap(phase => phase.steps).filter(step => negativeIds.includes(step.step_id))) {
      expect(step.skip_reason).toBe('prerequisite_failed');
    }
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'failing', failure_count: 1 });
  });

  it.each(['list_products', 'get_products'])('DOOH completes through %s alone with validate_input absent', async discoveryTool => {
    const storyboard = load('sales_dooh', surface);
    const tools = allTools.filter(tool => tool !== 'validate_input' &&
      !(['list_products', 'get_products'].includes(tool) && tool !== discoveryTool));
    const { result, calls } = await execute(storyboard, tools, capabilities(), {}, doohResponder(storyboard));
    expect(result.overall_passed, JSON.stringify(result.phases.flatMap(phase => phase.steps).filter(step => !step.passed))).toBe(true);
    expect(result.failed_count).toBe(0);
    expect(calls.map(call => call.task)).toContain(discoveryTool);
    expect(calls.map(call => call.task)).toContain('sync_creatives');
    expect(calls.map(call => call.task)).toContain('get_media_buy_delivery');
    expect(calls.filter(call => call.task === 'create_media_buy')).toHaveLength(2);
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'passing' });
  });

  it('DOOH fails without either discovery tool and blocks its negative consumer', async () => {
    const storyboard = load('sales_dooh', surface);
    const focused = { ...storyboard, phases: storyboard.phases.filter(phase =>
      ['product_discovery', 'identity_absence', 'create_buy', 'delivery'].includes(phase.id)) };
    const tools = allTools.filter(tool => !['get_products', 'list_products'].includes(tool));
    const { result, calls } = await execute(focused, tools);
    expect(calls).toEqual([]);
    expect(result.failed_count).toBeGreaterThan(0);
    const assertion = result.phases[0].steps.find(step => step.task === 'assert_contribution');
    expect(assertion?.passed).toBe(false);
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'failing' });
  });

  it('DOOH rejects a malformed advertised brief response and blocks the negative consumer', async () => {
    const storyboard = load('sales_dooh', surface);
    const focused = { ...storyboard, phases: storyboard.phases.filter(phase =>
      ['product_discovery', 'identity_absence'].includes(phase.id)) };
    const tools = allTools.filter(tool => tool !== 'list_products');
    const { result, calls } = await execute(focused, tools, capabilities(), {}, (_task, request) => ({
      success: true, data: { products: 'malformed', context: request.context },
    }));
    expect(calls.map(call => call.task)).toEqual(['get_products']);
    const brief = result.phases[0].steps.find(step => step.task === 'get_products');
    expect(brief?.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'response_schema', passed: false }),
    ]));
    expect(result.phases[1].steps[0].skip_reason).toBe('prerequisite_failed');
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'failing' });
  });

  it.each(['list_products', 'get_products'])('DOOH preserves a broken advertised %s failure when its peer passes', async broken => {
    const storyboard = load('sales_dooh', surface);
    const focused = { ...storyboard, phases: storyboard.phases.filter(phase => phase.id === 'product_discovery') };
    const { result, calls } = await execute(focused, allTools, capabilities(), {}, doohResponder(storyboard, broken));
    expect(calls.map(call => call.task)).toEqual(['list_products', 'get_products']);
    expect(result.failed_count).toBe(1);
    expect(result.phases[0].steps.find(step => step.task === 'assert_contribution')?.passed).toBe(true);
    expect(hosted(storyboard, result, allTools).statuses[0]).toMatchObject({ status: 'partial', failure_count: 1 });
  });

  it('availability buy absence skips both negative probes while list support remains independent', async () => {
    const storyboard = load('availability_windows', surface);
    const focused = slice(storyboard, ['reject_booked_span', 'reject_below_minimum']);
    const tools = allTools.filter(tool => tool !== 'buy_products');
    const raw = capabilities();
    raw.media_buy.lifecycle_tools = raw.media_buy.lifecycle_tools.filter(tool => tool !== 'buy_products');
    const { result, calls } = await execute(focused, tools, raw, state);
    expect(calls).toEqual([]);
    expect(result.failed_count).toBe(0);
    expect(hosted(storyboard, result, tools).statuses[0]).toMatchObject({ status: 'untested', steps_total: 0 });
  });
});
