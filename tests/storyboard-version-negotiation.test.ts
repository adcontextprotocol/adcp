import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadStoryboardFile, registerExternalSchemaRoot, runStoryboardStep, unregisterExternalSchemaRoot } from '@adcp/sdk/testing';

const sourceRoot = path.resolve('static/compliance/source');
const affected = [
  ['universal/ctv-experience-validate-input.yaml', 14],
  ['universal/premium-display-canonical-validation.yaml', 21],
  ['protocols/media-buy/scenarios/get_products_rejected.yaml', 2],
  ['universal/canonical-format-validate-input.yaml', 16],
] as const;
const tools = ['get_adcp_capabilities', 'validate_input', 'comply_test_controller', 'get_products', 'get_media_buy_delivery', 'get_reporting_status'];
const sellerUrl = 'https://seller.example/mcp';

type Call = { name: string; arguments: Record<string, unknown> };

// A transport fixture, not a mocked SDK client: initialize, tools/list, discovery,
// envelope construction and tools/call all go through the installed SDK.
function seller(selectedRelease: string) {
  const supported = [...new Set(['3.1', '3.2', selectedRelease])];
  const calls: Call[] = [];
  const capabilities = {
    adcp: { major_versions: [3], supported_versions: supported, idempotency: { supported: false } },
    supported_protocols: ['media_buy', 'creative'],
    experimental_features: ['media_buy.reporting_delivery'],
    media_buy: { reporting_delivery: {
      supported: true, reliable_reporting_version: '1.0', configuration_task: 'sync_accounts',
      status_task: 'get_reporting_status', revision_content_task: 'get_media_buy_delivery',
      automated_recovery_window_seconds: 21600, status_retention_days: 35,
      offerings: [{
        offering_id: 'daily-core', feed_purpose: 'analytics', report_definition_id: 'daily_v1',
        report_definition_uri: 'https://seller.example/reporting/daily-v1.json',
        report_definition_sha256: 'a'.repeat(64),
        reporting_profile: {
          id: 'daily_profile', version: '1.0', schema_uri: 'https://seller.example/reporting/profile.json',
          schema_sha256: 'b'.repeat(64), schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
          schema_ref_policy: 'local_fragment_only', grain: 'media buy per day', primary_keys: ['media_buy_id', 'date'],
        },
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        supported_finality: ['official'], reconciliation_mode: 'delivery_only',
      }],
    } },
    compliance_testing: { scenarios: ['force_get_products_arm', 'reporting_core_lifecycle_probe'] },
  };
  const trustedFetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    const message = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (!message || message.id === undefined) return new Response(null, { status: 202 });
    let result;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'Stable seller', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = { tools: tools.map(name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })) };
        break;
      case 'tools/call': {
        const call: Call = message.params;
        calls.push(call);
        const request = call.arguments;
        const accepted = supported.includes(request.adcp_version as string) && request.adcp_major_version === 3;
        let data: Record<string, unknown>;
        if (!accepted) {
          data = { adcp_error: {
            code: 'VERSION_UNSUPPORTED', message: 'Requested release is not advertised', recovery: 'correctable',
            details: { supported_versions: supported, supported_majors: [3] },
          } };
        } else if (call.name === 'get_adcp_capabilities') {
          data = { ...capabilities, status: 'completed' };
        } else if (call.name === 'comply_test_controller') {
          data = { status: 'completed', success: true, forced: request.params };
        } else if (call.name === 'get_products') {
          data = {
            status: 'rejected', reason: 'The requested budget is below the minimum for this inventory.',
            suggestions: ['Increase the campaign budget.', 'Consider display inventory for this flight.'],
          };
        } else {
          // These tests isolate dispatch/version acceptance. Empty results do not
          // pretend to implement the canonical-format semantic validator.
          data = { results: [] };
        }
        data = { ...data, adcp_version: accepted ? request.adcp_version : selectedRelease, context: request.context };
        result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: !accepted };
        break;
      }
      case 'server/discover':
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }), {
          headers: { 'content-type': 'application/json' },
        });
      default:
        throw new Error(`Unexpected MCP method: ${message.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, supported, transport: { trustedFetchFn } };
}

// Register disposable source snapshots for both selected releases. This also
// exercises maintenance SDKs that predate the stable 3.2 bundled schemas.
// Repository metadata and immutable released artifacts stay untouched.
const schemaRoots: string[] = [];
beforeAll(() => {
  for (const version of ['3.2.4', '3.3.0']) {
    const schemaRoot = mkdtempSync(path.join(tmpdir(), 'adcp-storyboard-version-'));
    schemaRoots.push(schemaRoot);
    cpSync(path.resolve('static/schemas/source'), schemaRoot, { recursive: true });
    // External roots require a versioned or latest namespace. Normalize only
    // this disposable copy, as build:schemas does for development output.
    for (const file of readdirSync(schemaRoot, { recursive: true }) as string[]) {
      if (!file.endsWith('.json')) continue;
      const filename = path.join(schemaRoot, file);
      writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll('"/schemas/', '"/schemas/latest/'));
    }
    const indexPath = path.join(schemaRoot, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({ ...index, adcp_version: version }));
    registerExternalSchemaRoot(version, schemaRoot);
  }
});
afterAll(() => {
  for (const version of ['3.2.4', '3.3.0']) unregisterExternalSchemaRoot(version);
  for (const schemaRoot of schemaRoots) rmSync(schemaRoot, { recursive: true, force: true });
});

for (const [bundleVersion, wireVersion] of [['3.2.4', '3.2'], ['3.3.0', '3.3']] as const) {
  describe(`runner-selected ${wireVersion}`, () => {
    for (const [file, count] of affected) {
      it(`dispatches all ${count} ${file} steps using the selected release`, async () => {
        const endpoint = seller(wireVersion);
        const storyboard = { ...loadStoryboardFile(path.join(sourceRoot, file)), adcp_version: bundleVersion };
        const steps = storyboard.phases.flatMap(phase => phase.steps);
        expect(steps).toHaveLength(count);
        for (const step of steps) {
          const start = endpoint.calls.length;
          const result = await runStoryboardStep(sellerUrl, storyboard, step.id, { transport: endpoint.transport });
          const sent = endpoint.calls.slice(start).filter(call => call.name === step.task);
          expect(sent, step.id).toHaveLength(1);
          expect(sent[0].arguments.adcp_version, step.id).toBe(wireVersion);
          expect(sent[0].arguments.adcp_major_version, step.id).toBe(3);
          expect(result.skipped, step.id).not.toBe(true);
          expect(result.response, step.id).toMatchObject({ adcp_version: wireVersion });
          expect(result.response, step.id).not.toHaveProperty('adcp_error');
          // This business rejection is a transport success, not a negative
          // version test. Keep every authored rejection-arm assertion active.
          if (file.includes('get_products_rejected')) expect(result.passed, JSON.stringify(result)).toBe(true);
        }
        expect(endpoint.calls.some(call => call.name === 'get_adcp_capabilities')).toBe(true);
        expect(endpoint.supported).not.toContain('3.2-beta.6');
        expect(endpoint.supported).not.toContain('3.1-beta.5');
      }, 60_000);
    }
  });
}

it('preserves unsupported-release and RC0 exact-read negative tests on the wire', async () => {
  const endpoint = seller('3.2');
  for (const [file, stepId, expectedVersion] of [
    ['universal/error-compliance.yaml', 'unsupported_release_version', '99.0'],
    ['universal/reporting-core.yaml', 'exact_nonempty_reject_rc0', '3.2-rc.0'],
  ]) {
    const storyboard = loadStoryboardFile(path.join(sourceRoot, file));
    const step = storyboard.phases.flatMap(phase => phase.steps).find(candidate => candidate.id === stepId)!;
    expect(step.expect_error).toBe(true);
    const start = endpoint.calls.length;
    const result = await runStoryboardStep(sellerUrl, storyboard, stepId, {
      adcpVersion: '3.2.4', transport: endpoint.transport,
      context: { reporting_core_nonempty_revision_id: 'seller-issued-revision' },
    });
    const sent = endpoint.calls.slice(start).filter(call => call.name === step.task);
    expect(sent, JSON.stringify(result)).toHaveLength(1);
    expect(sent[0].arguments.adcp_version).toBe(expectedVersion);
    expect(result.skipped).not.toBe(true);
    expect(result.passed, JSON.stringify(result)).toBe(true);
    expect(result.response).toMatchObject({ adcp_error: { code: 'VERSION_UNSUPPORTED' } });
  }
}, 30_000);

it('reproduces the stale prerelease refusal without overriding caller versions', async () => {
  for (const [file, staleVersion] of [
    ['universal/ctv-experience-validate-input.yaml', '3.2-beta.6'],
    ['universal/canonical-format-validate-input.yaml', '3.1-beta.5'],
  ]) {
    const endpoint = seller('3.2');
    const storyboard = loadStoryboardFile(path.join(sourceRoot, file));
    const step = storyboard.phases[0].steps[0];
    step.sample_request = { ...step.sample_request, adcp_version: staleVersion };
    const result = await runStoryboardStep(sellerUrl, storyboard, step.id, {
      adcpVersion: '3.2.4', transport: endpoint.transport,
    });
    const sent = endpoint.calls.filter(call => call.name === step.task);
    expect(sent).toHaveLength(1);
    expect(sent[0].arguments.adcp_version).toBe(staleVersion);
    expect(result.skipped).not.toBe(true);
    expect(result.passed).toBe(false);
    expect(result.response).toMatchObject({ adcp_error: { code: 'VERSION_UNSUPPORTED' } });
  }
}, 30_000);
