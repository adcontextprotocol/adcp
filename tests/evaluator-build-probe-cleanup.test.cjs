// Maintenance integration regressions adapted from merged adcp-client#3332.
// Run against this branch's actual, unchanged SDK dependency.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseStoryboard, runStoryboard, runStoryboardStep } = require('@adcp/sdk/testing');
const path = require('node:path');
const { registerMCPConnectionScopeCleanup, withMCPConnectionScope } = require(path.resolve(require.resolve('@adcp/sdk/testing'), '../../protocols/mcp-scope.js'));

function storyboard() {
  return parseStoryboard(`
id: creative_probe_cleanup
version: "1.0.0"
title: Creative probe cleanup
category: creative
summary: Cleanup after fixture authoring errors
creative_build_probe:
  context_prefix: build
  message: Create one sandbox creative
phases:
  - id: boundary
    title: Evaluator boundary
    steps:
      - id: reject
        title: Reject off-list evaluator
        task: build_creative
        requires_contract: creative_build_probe_runner
        expect_error: true
        sample_request:
          evaluator:
            agent_url: "https://off-list.example/adcp"
        validations:
          - check: error_code
            value: EVALUATOR_AGENT_NOT_ACCEPTED
`);
}

function options() {
  const tools = ['get_adcp_capabilities', 'build_creative'];
  return {
    agentTools: tools,
    _profile: {
      tools,
      raw_capabilities: {
        creative: {
          supports_generation: true,
          supports_evaluator: true,
          supported_formats: [
            {
              capability_id: 'build',
              operations: ['build'],
              format: { format_kind: 'image', params: {}, technical_requirements_complete: true },
            },
          ],
        },
      },
    },
    _controllerCapabilities: { detected: false, scenarios: [] },
    _client: {
      resetContext() {},
      async executeTask() {
        assert.fail('Fixture preparation must finish before any tool is dispatched');
      },
    },
    test_kit: {
      creative_build_probes: [
        {
          match: [{ path: '/capability_id', operator: 'equals', value: 'build' }],
          input: { evaluator: { agent_url: 'https://injected.example/adcp' } },
        },
      ],
    },
  };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server) {
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

test('fixture authoring errors close the real owned listener and its isolated connection scope', async t => {
  const reservation = http.createServer();
  await listen(reservation, 0);
  const port = reservation.address().port;
  await close(reservation);

  // Keep the failure path test safe against regressions that leave a real
  // listener open: record created servers and release them after assertions.
  const servers = [];
  const originalCreateServer = http.createServer;
  t.mock.method(http, 'createServer', (...args) => {
    const server = originalCreateServer(...args);
    servers.push(server);
    return server;
  });
  t.after(async () => {
    await Promise.all(servers.map(close));
  });

  let callerClosed = 0;
  let runnerClosed = 0;
  const opts = options();
  opts._client.resetContext = () => {
    registerMCPConnectionScopeCleanup('modern', 'runner-owned', async () => runnerClosed++);
  };
  await withMCPConnectionScope(async () => {
    registerMCPConnectionScopeCleanup('modern', 'caller-owned', async () => callerClosed++);
    await assert.rejects(
      runStoryboard('https://agent.example/mcp', storyboard(), {
        ...opts,
        allow_http: true,
        webhook_receiver: { host: '127.0.0.1', port },
      }),
      /input may only/
    );
    assert.equal(runnerClosed, 1);
    assert.equal(callerClosed, 0, 'the caller connection lifetime remains open');
    const replacement = http.createServer();
    await listen(replacement, port);
    await close(replacement);
  });
  assert.equal(callerClosed, 1);
});

test('standalone fixture authoring errors preserve the externally injected receiver', async () => {
  let receiverClosed = 0;
  const receiver = {
    base_url: 'https://receiver.example',
    async close() {
      receiverClosed++;
    },
  };
  await assert.rejects(
    runStoryboardStep('https://agent.example/mcp', storyboard(), 'reject', {
      ...options(),
      _webhookReceiver: receiver,
    }),
    /input may only/
  );
  assert.equal(receiverClosed, 0);
});

test('malformed producer catalogs cascade as catalog prerequisites rather than controller failures', async () => {
  const opts = options();
  delete opts.test_kit;
  opts._profile.raw_capabilities.creative.supported_formats[0].format.seller_preference = 'INVALID';
  const result = await runStoryboard('https://agent.example/mcp', storyboard(), opts);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(result.fixture_resolutions[0].status, 'failed');
  const rejectedProbe = result.phases.find(phase => phase.phase_id === 'boundary').steps[0];
  assert.equal(rejectedProbe.skipped, true);
  assert.equal(rejectedProbe.skip_reason, 'prerequisite_failed');
  assert.equal(rejectedProbe.skip.reason, 'prerequisite_failed');
  assert.match(rejectedProbe.skip.detail, /fixture_resolution\.creative_build_catalog/);
});
