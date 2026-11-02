import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const probes = vi.hoisted(() => ({ results: [] as unknown[] }));
vi.mock('@adcp/sdk/testing', async importOriginal => {
  const actual = await importOriginal<typeof import('@adcp/sdk/testing')>();
  return { ...actual, testCapabilityDiscovery: async (...args: Parameters<typeof actual.testCapabilityDiscovery>) => {
    const result = await actual.testCapabilityDiscovery(...args);
    probes.results.push(result);
    return result;
  } };
});
import { loadStoryboardFile } from '@adcp/sdk/testing';
import { runCatalogReportingStoryboard } from '../../src/compliance/catalog-reporting-runner.js';

it('preflight validates an echoed served release against the caller-provided artifact', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const scratch = mkdtempSync(path.join(tmpdir(), 'reporting-served-root-'));
  try {
    const served = path.join(scratch, 'served');
    cpSync(path.join(root, 'dist/schemas/3.2.5'), served, { recursive: true });
    for (const relative of ['protocol/get-adcp-capabilities-response.json', 'bundled/protocol/get-adcp-capabilities-response.json']) {
      const schemaFile = path.join(served, relative);
      const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
      schema.required = [...(schema.required ?? []), 'controlled_served_artifact_marker'];
      writeFileSync(schemaFile, JSON.stringify(schema));
    }
    const tools = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_media_buy_delivery', 'comply_test_controller'];
    const fetchFn: typeof fetch = async (_url, init = {}) => {
      if (!init.body) return new Response(null, { status: init.method === 'DELETE' ? 202 : 405 });
      const message = JSON.parse(String(init.body));
      let result;
      if (message.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No extension' } });
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'schema-scope-oracle', version: '1' } };
      else if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
      else if (message.method === 'tools/list') result = { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) };
      else {
        const name = message.params.name;
        const data = name === 'get_adcp_capabilities' ? {
          status: 'completed', adcp_version: '3.2',
          adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
          supported_protocols: ['media_buy'], media_buy: { buying_modes: ['brief'] },
        } : { success: true };
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    };
    probes.results = [];
    const storyboard = loadStoryboardFile(path.join(root, 'static/compliance/source/protocols/media-buy/scenarios/advanced_delivery_reporting.yaml'));
    await runCatalogReportingStoryboard('https://schema-root-oracle.example/mcp', storyboard, {
      adcpVersion: '3.0', schemaRoot: path.join(root, 'dist/schemas/3.0.0'),
      servedReleaseSchemaRoots: { '3.2': served }, transport: { trustedFetchFn: fetchFn }, timeout_ms: 3000,
    });
    expect(probes.results).toHaveLength(1);
    expect(JSON.stringify(probes.results[0])).toContain('controlled_served_artifact_marker');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
