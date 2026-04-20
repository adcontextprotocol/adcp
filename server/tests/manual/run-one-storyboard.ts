/**
 * Diagnostic: dump the raw runStoryboard() result for a single storyboard.
 *   npx tsx server/tests/manual/run-one-storyboard.ts capability_discovery
 */

import express from 'express';
import http from 'node:http';
import { listAllComplianceStoryboards, runStoryboard } from '@adcp/client/testing';
import { StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';

const AUTH_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN ?? 'storyboard-diag-token';
process.env.PUBLIC_TEST_AGENT_TOKEN = AUTH_TOKEN;
if (!process.env.LOG_STORYBOARDS) process.env.LOG_LEVEL = 'silent';

const id = process.argv[2];
if (!id) { console.error('usage: run-one-storyboard.ts <storyboard_id>'); process.exit(2); }

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { getPublicJwks } = await import('../../src/training-agent/webhooks.js');

const sb = listAllComplianceStoryboards().find(s => s.id === id);
if (!sb) { console.error(`storyboard ${id} not found`); process.exit(2); }

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/training-agent', createTrainingAgentRouter());
const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/training-agent/mcp`;
  // Intentionally do not log agent URL to stdout — this script's stdout is
  // piped through `jq` / `python -c` by the storyboard debugging workflow.
  const result = await runStoryboard(url, sb, {
    auth: { type: 'bearer', token: AUTH_TOKEN },
    allow_http: true,
    contracts: ['webhook_receiver_runner'],
    webhook_receiver: { mode: 'loopback_mock' },
    webhook_signing: {
      jwks: new StaticJwksResolver(getPublicJwks().keys as AdcpJsonWebKey[]),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
    },
  });
  console.log(JSON.stringify(result, null, 2));
  stopSessionCleanup();
  server.close();
});
