'use strict';
process.env.NODE_ENV = 'test';
const fs = require('node:fs');
const path = require('node:path');
const mcpPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')), '../../../package.json')));
const { createAdcpServer } = require('@adcp/sdk/server/legacy/v5');
const { createIdempotencyStore, memoryBackend, adcpError } = require('@adcp/sdk/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

async function main() {
  const plan = JSON.parse(fs.readFileSync(process.argv[2]));
  let active, called, served;
  function handler(params, ctx) {
    called = true;
    served = ctx.servedAdcpVersion;
    if (active.kind === 'error') return adcpError(active.code, { message: 'Conformance fixture', ...(active.recovery && { recovery: active.recovery }) });
    return active.tool === 'get_products'
      ? { products: [], cache_scope: 'public', wholesale_feed_version: 'fixture-feed' }
      : { outcome: 'listed', products: [], feed_version: 'fixture-feed', cache_scope: 'public' };
  }
  const server = createAdcpServer({
    name: 'conformance-seller', version: '1.0.0', mcpToolProfile: 'all', adcpVersion: plan.protocol.version,
    capabilities: { supported_versions: [plan.protocol.version] },
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveSessionKey: () => 'conformance-session',
    // Capture output before SDK self-validation can replace an invalid result.
    // The report always validates the captured response against release schemas.
    validation: { requests: 'strict', responses: 'off' },
    mediaBuy: { getProducts: handler, listProducts: handler },
  });
  const client = new Client({ name: 'conformance-buyer', version: '1.0.0' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  const observations = [];
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const advertised_tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const probe of plan.cases) {
      active = probe; called = false; served = null;
      if (!advertised_tools.includes(probe.tool)) { observations.push({ id: probe.id, skip: 'Not advertised by configured SDK server' }); continue; }
      try {
        const result = await client.callTool({ name: probe.tool, arguments: probe.request });
        observations.push({ id: probe.id, handler_called: called, handler_served_version: served, result });
      } catch (error) { observations.push({ id: probe.id, handler_called: called, transport_error: error.message }); }
    }
    process.stdout.write(JSON.stringify({ sdk: { language: 'typescript', package: '@adcp/sdk', version: require('@adcp/sdk/package.json').version, runtime: process.version, mcp: mcpPackage.version }, transport: 'MCP InMemoryTransport + createAdcpServer (legacy/v5 server entry)', advertised_tools, observations }, null, 2) + '\n');
  } finally { await client.close(); await server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 2; });
