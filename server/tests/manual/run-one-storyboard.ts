/**
 * Diagnostic: dump the raw runStoryboard() result for a single storyboard.
 *   npx tsx server/tests/manual/run-one-storyboard.ts capability_discovery
 */

import express from 'express';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { listAllComplianceStoryboards, runStoryboard, getComplianceCacheDir } from '@adcp/client/testing';
import type { Storyboard, StoryboardRunOptions } from '@adcp/client/testing';
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

interface LoadedKit {
  brand?: { house?: { domain?: string } };
  auth?: { api_key?: string; probe_task?: string };
}

function loadKit(s: Storyboard): LoadedKit | undefined {
  const kitRef = s.prerequisites?.test_kit;
  if (!kitRef) return undefined;
  const path = join(getComplianceCacheDir(), kitRef);
  if (!existsSync(path)) return undefined;
  return YAML.parse(readFileSync(path, 'utf-8')) as LoadedKit;
}

const app = express();
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
  },
}));
// API-key-only agent: MUST NOT serve RFC 9728 PRM. See
// server/tests/manual/run-storyboards.ts and
// static/compliance/source/universal/security.yaml lines 37–47.
app.use('/api/training-agent', createTrainingAgentRouter());
const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/training-agent/mcp`;
  // Intentionally do not log agent URL to stdout — this script's stdout is
  // piped through `jq` / `python -c` by the storyboard debugging workflow.
  const kit = loadKit(sb);
  const domain = kit?.brand?.house?.domain;
  const brand: StoryboardRunOptions['brand'] | undefined = domain ? { domain } : undefined;
  const testKit: StoryboardRunOptions['test_kit'] | undefined = (() => {
    const a = kit?.auth;
    if (!a?.api_key && !a?.probe_task) return undefined;
    if (!a.probe_task) throw new Error('test kit declares auth.api_key without auth.probe_task');
    return {
      auth: {
        ...(a.api_key !== undefined && { api_key: a.api_key }),
        probe_task: a.probe_task,
      },
    };
  })();
  try {
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
      request_signing: { transport: 'mcp' },
      ...(brand && { brand }),
      ...(testKit && { test_kit: testKit }),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    stopSessionCleanup();
    server.close();
  }
});
