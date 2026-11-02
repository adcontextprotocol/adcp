import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildComplianceBundleResults, comply, runStoryboard, type ComplianceResult } from '@adcp/sdk/testing';
import * as storyboardCache from '../../src/compliance/storyboard-cache.js';
import { getCachedComplianceStoryboardById } from '../../src/compliance/storyboard-cache.js';
import {
  complianceResultToDbInput,
  deriveStoryboardStatuses,
} from '../../src/addie/services/compliance-testing.js';
import { deriveVerificationProfileRoleAssessments } from '../../src/services/verification-profile-assessment.js';
import { hostedComplianceOptions, hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';

// Exercise the installed SDK's projection as well as its public runner. The
// mapper has no public export; resolve its file from the public testing entry.
const require = createRequire(import.meta.url);
const { mapStoryboardResultsToTrackResult } = require(join(
  dirname(require.resolve('@adcp/sdk/testing')), 'compliance/storyboard-tracks.js',
));
const agentUrl = 'https://uncontacted.example/mcp';
const profile = {
  name: 'No-controller seller',
  tools: ['get_adcp_capabilities', 'get_products', 'get_media_buys', 'create_media_buy'],
  supported_protocols: ['media_buy'],
  specialisms: ['sales-non-guaranteed'],
  adcp_major_versions: [3],
  adcp_supported_versions: ['3.0'],
  raw_capabilities: { supported_protocols: ['media_buy'] },
};

async function replay(version: string, id: string): Promise<ComplianceResult> {
  const options = hostedComplianceOptions(hostedComplianceTarget(version));
  const storyboard = getCachedComplianceStoryboardById(id, options)!;
  expect(storyboard.prerequisites?.controller_seeding).toBe(true);
  const calls: string[] = [];
  const client = new Proxy({ resetContext() {} }, {
    get(target, key) {
      if (key === 'resetContext') return target.resetContext;
      return () => {
        calls.push(String(key));
        throw new Error('An unseeded fixture must never be dispatched');
      };
    },
  });
  const run = await runStoryboard(agentUrl, storyboard, {
    ...options,
    _profile: profile,
    agentTools: profile.tools,
    _client: client,
  } as Parameters<typeof runStoryboard>[2]);
  expect(calls).toEqual([]);
  expect(run).toMatchObject({ overall_passed: false, passed_count: 0, failed_count: 0 });
  const track = mapStoryboardResultsToTrackResult('core', [run], profile);
  expect(track.scenarios.find((scenario: { scenario: string }) => scenario.scenario === `${id}/storyboard`))
    .toMatchObject({ overall_passed: false, steps: [] });
  const bundle = buildComplianceBundleResults([{
    ref: { kind: 'universal', id: 'controller-fixture', path: '/unused' },
    storyboards: [storyboard],
  }], [run]);
  expect(bundle[0].status).toBe('partial');
  return {
    agent_url: agentUrl,
    adcp_version: version,
    completeness: 'complete',
    agent_profile: { ...profile, adcp_supported_versions: [version.slice(0, 3)] },
    overall_status: 'partial',
    tracks: [track],
    tested_tracks: [],
    skipped_tracks: [],
    bundle_results: bundle,
    summary: { headline: 'No fixture evidence', tracks_passed: 0, tracks_failed: 0,
      tracks_partial: 0, tracks_skipped: 1, tracks_silent: 0 },
    observations: [],
    tested_at: '2026-10-29T00:00:00Z',
    total_duration_ms: 0,
  } as ComplianceResult;
}

describe('hosted controller preflight gaps (#8576)', () => {
  let baseline: ComplianceResult;
  beforeAll(async () => { baseline = await replay('3.0.28', 'schema_validation'); });

  it.each([
    ['3.0.28', 'schema_validation'],
    ['3.0.28', 'get_media_buys_pagination_integrity'],
    ['3.0.28', 'media_buy_seller/create_media_buy_async'],
    ['3.1.29', 'schema_validation'],
  ])('retains untested coverage from the immutable %s / %s storyboard', async (version, id) => {
    const result = await replay(version, id);
    const original = structuredClone(result);
    const expected = [{ storyboard_id: id, status: 'untested', steps_passed: 0, steps_total: 0 }];
    expect(deriveStoryboardStatuses(result)).toEqual(expected);
    const stored = complianceResultToDbInput(result, agentUrl, 'production');
    expect(stored.storyboard_statuses).toEqual(expected);
    expect(stored.overall_status).toBe('partial');
    expect(stored.tracks_failed).toBe(0);
    expect(stored.tracks_json).toEqual([expect.objectContaining({ status: 'skip', has_coverage_gap_skip: true })]);
    expect(stored.step_diagnostics).toEqual([]);
    expect(result.bundle_results?.[0].status).toBe('partial');
    expect(result).toEqual(original);
  });

  it('keeps Strict incomplete when its claimed role passed but required fixture evidence did not run', () => {
    const result = structuredClone(baseline);
    result.bundle_results!.push(
      { kind: 'protocol', id: 'media-buy', storyboard_ids: ['media_buy_seller'], status: 'passing' },
      { kind: 'specialism', id: 'sales-non-guaranteed', storyboard_ids: ['sales_non_guaranteed'], status: 'passing' },
    );
    const assessments = deriveVerificationProfileRoleAssessments({
      result, lifecycleStage: 'production', requestedComplianceTarget: '3.0',
      storyboardStatuses: [...deriveStoryboardStatuses(result), {
        storyboard_id: 'sales_non_guaranteed', status: 'passing', steps_passed: 1, steps_total: 1,
      }],
    });
    expect(assessments.find(assessment => assessment.grading_profile === 'legacy')?.status).toBe('passing');
    expect(assessments.find(assessment => assessment.grading_profile === 'spec')).toMatchObject({
      status: 'partial', evidence: expect.objectContaining({ incomplete_bundle_count: 1 }),
    });
  });

  it('keeps real MCP no-controller execution untested without dispatching fixture purchases', async () => {
    const calls: string[] = [];
    const connections: McpServer[] = [];
    const server = createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'No-controller acceptance seller', version: '1.0.0' });
      for (const name of profile.tools) {
        mcp.registerTool(name, {}, async () => {
          calls.push(name);
          if (name !== 'get_adcp_capabilities') throw new Error('Fixture operation dispatched without setup');
          const data = {
            adcp: { major_versions: [3], supported_versions: ['3.0'], build_version: '3.0.28',
              idempotency: { supported: false } },
            supported_protocols: ['media_buy'], specialisms: [],
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
        });
      }
      connections.push(mcp);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
      const result = await comply(url, {
        ...hostedComplianceOptions(hostedComplianceTarget('3.0.28')),
        allow_http: true,
        storyboards: ['schema_validation', 'media_buy_seller/create_media_buy_async'],
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(name => name === 'get_adcp_capabilities')).toBe(true);
      expect(result.tracks.flatMap(track => track.scenarios).filter(scenario =>
        String(scenario.scenario).endsWith('/storyboard'))).toHaveLength(2);
      expect(deriveStoryboardStatuses(result)).toEqual([
        { storyboard_id: 'schema_validation', status: 'untested', steps_passed: 0, steps_total: 0 },
        { storyboard_id: 'media_buy_seller/create_media_buy_async', status: 'untested', steps_passed: 0, steps_total: 0 },
      ]);
      expect(complianceResultToDbInput(result, url, 'production').tracks_failed).toBe(0);
    } finally {
      await Promise.all(connections.map(connection => connection.close()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('does not reinterpret an authored phase named storyboard as an SDK verdict', () => {
    const result = structuredClone(baseline);
    const lookup = storyboardCache.getCachedComplianceStoryboardById;
    const spy = vi.spyOn(storyboardCache, 'getCachedComplianceStoryboardById').mockImplementation((id, options) => {
      const storyboard = lookup(id, options);
      storyboard?.phases.push({ id: 'storyboard', title: 'Authored checks', steps: [] });
      return storyboard;
    });
    try {
      expect(deriveStoryboardStatuses(result)[0].status).toBe('failing');
    } finally { spy.mockRestore(); }
  });

  it.each([
    'executed pass', 'executed failure', 'prerequisite failure', 'failed validation',
    'missing preflight', 'step-less failure', 'flat failure', 'unattributed flat failure',
    'assertion', 'unattributed assertion', 'track assertion', 'unknown bundle', 'line alias', 'duplicate verdict',
  ])('preserves the authoritative failure with %s evidence', kind => {
    const result = structuredClone(baseline);
    const phases = result.tracks[0].scenarios;
    const preflight = phases.find(phase => phase.scenario === 'schema_validation/__controller_seeding__')!;
    const ordinary = phases.find(phase => phase !== preflight && phase.steps?.length)!;
    const row = ordinary.steps[0];
    switch (kind) {
      case 'executed pass': row.skipped = false; break;
      case 'executed failure': row.skipped = false; row.passed = false; break;
      case 'prerequisite failure': row.skip_reason = 'prerequisite_failed'; row.passed = false; break;
      case 'failed validation': row.validations = [{ check: 'field_present', passed: false }]; break;
      case 'missing preflight': phases.splice(phases.indexOf(preflight), 1); break;
      case 'step-less failure': phases.push({ ...ordinary, scenario: 'schema_validation/unknown' as never,
        overall_passed: false, steps: [] }); break;
      case 'flat failure':
      case 'unattributed flat failure':
        result.failures = [{ storyboard_id: kind === 'flat failure' ? 'schema_validation' : undefined } as never];
        break;
      case 'assertion':
      case 'unattributed assertion':
      case 'track assertion': {
        const observation = { category: 'error_compliance', severity: 'error', message: 'Assertion failed',
          source: { kind: 'storyboard', code: 'storyboard-assertion-failed',
            ...(kind !== 'unattributed assertion' && { storyboard_id: 'schema_validation' }) } } as const;
        if (kind === 'track assertion') result.tracks[0].observations.push(observation);
        else result.observations.push(observation);
        break;
      }
      case 'unknown bundle': result.adcp_version = '3.0.99999'; break;
      case 'line alias': result.adcp_version = '3.0'; break;
      case 'duplicate verdict': phases.push({ ...phases.find(phase =>
        phase.scenario === 'schema_validation/storyboard')! }); break;
    }
    expect(['partial', 'failing']).toContain(deriveStoryboardStatuses(result)[0].status);
    expect(['partial', 'failing']).toContain(complianceResultToDbInput(result, agentUrl, 'production')
      .storyboard_statuses?.[0].status);
  });
});
