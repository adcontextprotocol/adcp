/**
 * adcp#8676: the /governance training tenant advertises a creative feature
 * catalog in get_adcp_capabilities and evaluates it through
 * get_creative_features, so a learner can discover a feature_id and interpret
 * a binary, a quantitative and a categorical result.
 */
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';

const PUBLIC_BEARER = 'test-token-governance-creative-features';
process.env.PUBLIC_TEST_AGENT_TOKEN ??= PUBLIC_BEARER;

import { stopSessionCleanup } from '../../src/training-agent/state.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { TRAINING_CREATIVE_FEATURES } from '../../src/training-agent/task-handlers.js';

const ROOT_ENVELOPE_KEYS = new Set(['adcp_version', 'status', 'replayed']);

interface FeatureResult {
  feature_id: string;
  value: unknown;
  confidence?: number;
}

let governanceUrl = '';
let closeServer: () => Promise<void> = async () => {};
let rpcId = 0;

beforeAll(async () => {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
  const srv = http.createServer(app);
  await new Promise<void>(done => srv.listen(0, '127.0.0.1', () => done()));
  closeServer = () => new Promise(done => srv.close(() => done()));
  governanceUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/training-agent/governance/mcp`;
});

afterAll(async () => {
  stopSessionCleanup();
  await closeServer();
});

async function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  rpcId += 1;
  const response = await fetch(governanceUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${process.env.PUBLIC_TEST_AGENT_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params && { params }) }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const json = await rpc('tools/call', { name, arguments: args }) as { result?: { structuredContent?: Record<string, unknown> } };
  const structured = json.result?.structuredContent;
  expect(structured, JSON.stringify(json).slice(0, 500)).toBeDefined();
  return structured!;
}

function schemaErrors(errors: Array<{ instancePath: string; keyword: string; params: unknown; message?: string }>): string[] {
  return errors
    .filter(entry => !(
      entry.instancePath === ''
      && entry.keyword === 'additionalProperties'
      && ROOT_ENVELOPE_KEYS.has(String((entry.params as { additionalProperty?: unknown }).additionalProperty))
    ))
    .map(entry => `${entry.instancePath} ${entry.message} ${JSON.stringify(entry.params)}`);
}

function manifest(url: string): Record<string, unknown> {
  return {
    format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
    assets: { image: { asset_type: 'image', url, width: 300, height: 250 } },
  };
}

describe('governance tenant creative features (adcp#8676)', () => {
  it('advertises a binary, a quantitative and a categorical creative feature', async () => {
    const caps = await callTool('get_adcp_capabilities', {});
    expect(caps.supported_protocols).toContain('governance');
    const features = (caps.governance as { creative_features?: unknown[] } | undefined)?.creative_features;
    expect(features).toEqual(TRAINING_CREATIVE_FEATURES);
    expect(new Set(TRAINING_CREATIVE_FEATURES.map(feature => feature.type))).toEqual(
      new Set(['binary', 'quantitative', 'categorical']),
    );

    const source = validateSourceSchema('protocol/get-adcp-capabilities-response.json', caps);
    expect(schemaErrors(source.errors)).toEqual([]);
    const validateStable = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: '3.2' });
    expect(validateStable).toBeDefined();
    validateStable!(caps);
    expect(schemaErrors(validateStable!.errors ?? [])).toEqual([]);
  });

  it('lists get_creative_features on the governance tenant', async () => {
    const json = await rpc('tools/list') as { result?: { tools?: Array<{ name: string }> } };
    expect(json.result?.tools?.map(tool => tool.name)).toContain('get_creative_features');
  });

  it('evaluates every advertised feature with a value of the advertised type', async () => {
    const response = await callTool('get_creative_features', {
      creative_manifest: manifest('https://cdn.example.com/spring-launch-300x250.jpg'),
      context: { correlation_id: 'governance-creative-features' },
    });
    expect(typeof response.evaluation_id).toBe('string');
    expect(response.context).toEqual({ correlation_id: 'governance-creative-features' });

    const results = response.results as FeatureResult[];
    expect(results.map(result => result.feature_id)).toEqual(TRAINING_CREATIVE_FEATURES.map(feature => feature.feature_id));
    for (const definition of TRAINING_CREATIVE_FEATURES) {
      const { value } = results.find(result => result.feature_id === definition.feature_id)!;
      if (definition.type === 'binary') expect(typeof value).toBe('boolean');
      if (definition.type === 'quantitative') {
        expect(value).toBeGreaterThanOrEqual(definition.range!.min);
        expect(value).toBeLessThanOrEqual(definition.range!.max);
      }
      if (definition.type === 'categorical') expect(definition.categories).toContain(value);
    }
    expect(results.find(result => result.feature_id === 'content_category')?.value).toBe('general');

    const source = validateSourceSchema('creative/get-creative-features-response.json', response);
    expect(schemaErrors(source.errors)).toEqual([]);
  });

  it('derives the categorical content_category from the asset URL and honors feature_ids', async () => {
    const response = await callTool('get_creative_features', {
      creative_manifest: manifest('https://cdn.example.com/gambling-banner-300x250.jpg'),
      feature_ids: ['content_category'],
    });
    expect(response.results).toEqual([{ feature_id: 'content_category', value: 'gambling', confidence: 0.9 }]);
  });

  it('matches content categories as whole words in the asset path only', async () => {
    for (const url of [
      'https://cdn.example.com/apolitical-explainer.jpg',
      'https://cdn.example.com/nonalcoholic-spritz.jpg',
      'https://gambling.example.com/banner.jpg?campaign=political',
    ]) {
      const response = await callTool('get_creative_features', { creative_manifest: manifest(url), feature_ids: ['content_category'] });
      expect(response.results, url).toEqual([{ feature_id: 'content_category', value: 'general', confidence: 0.7 }]);
    }
  });

  it('names the governance tenant in audit observations', async () => {
    const response = await callTool('get_creative_features', {
      creative_manifest: {
        ...manifest('https://cdn.example.com/ai-generated-true.jpg'),
        provenance: { digital_source_type: 'trained_algorithmic_media', human_oversight: 'edited', disclosure: { required: false } },
      },
      feature_ids: ['ai_generated'],
    });
    const observations = response.audit_observations as Array<{ details: { agent_url: string } }>;
    expect(observations).toHaveLength(1);
    expect(observations[0].details.agent_url).toMatch(/\/governance\/mcp$/);
  });

  it('replays a keyed evaluation with the same evaluation_id', async () => {
    const args = {
      idempotency_key: 'governance-creative-features-replay-0001',
      creative_manifest: manifest('https://cdn.example.com/ai-generated-true.jpg'),
      feature_ids: ['ai_generated'],
    };
    const first = await callTool('get_creative_features', args);
    const replay = await callTool('get_creative_features', args);
    expect(first.results).toEqual([{ feature_id: 'ai_generated', value: true, confidence: 0.95 }]);
    expect(first.evaluation_id).toEqual(expect.any(String));
    expect(replay.replayed).toBe(true);
    expect(replay.evaluation_id).toBe(first.evaluation_id);
  });
});
