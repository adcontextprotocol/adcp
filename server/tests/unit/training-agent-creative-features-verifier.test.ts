/**
 * adcp#8199: the public conformance verifier for provenance truth-of-claim.
 *
 * The route at /governance/creative-features/mcp must answer with no bearer,
 * stay fixture-keyed (ai_generated:true only for the "true" asset), serve no
 * other tool, and be rate limited per IP. The storyboards must point at it,
 * and the fixture images they name must exist as served static files.
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-creative-features-verifier';
});

import { stopSessionCleanup } from '../../src/training-agent/state.js';
import { jsonBodyLimitForPath } from '../../src/utils/json-body-limit.js';

const ROOT = resolve(__dirname, '../../..');
const SCENARIOS = resolve(ROOT, 'static/compliance/source/protocols/media-buy/scenarios');
const VERIFIER_URL = 'https://test-agent.adcontextprotocol.org/governance/creative-features/mcp';
const ASSET_BASE = 'https://adcontextprotocol.org/test-assets/acme-outdoor/';
const TRUE_ASSET = `${ASSET_BASE}ai-generated-true.jpg`;
const FALSE_ASSET = `${ASSET_BASE}ai-generated-false.jpg`;

let rateLimitedBase = '';
let bareBase = '';
let mountedBase = '';
let unlimitedBase = '';
const closers: Array<() => Promise<void>> = [];

async function serve(disableRateLimit: boolean): Promise<string> {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit }));
  const srv = http.createServer(app);
  await new Promise<void>(done => srv.listen(0, '127.0.0.1', () => done()));
  closers.push(() => new Promise(done => srv.close(() => done())));
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/training-agent`;
}

/**
 * Mirrors the main app's wiring in http.ts: the transport body cap comes from
 * `jsonBodyLimitForPath(req.path)` before routing, and the training-agent router
 * is reachable both under `/api/training-agent` and bare (host-based routing).
 */
async function serveWithTransportCaps(): Promise<{ bare: string; mounted: string }> {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use((req, res, next) => express.json({ limit: jsonBodyLimitForPath(req.path) })(req, res, next));
  const router = createTrainingAgentRouter({ disableRateLimit: true });
  app.use('/api/training-agent', router);
  app.use(router);
  // Body-parser failures surface as Express errors; return their status.
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: 'body_error' });
  });
  const srv = http.createServer(app);
  await new Promise<void>(done => srv.listen(0, '127.0.0.1', () => done()));
  closers.push(() => new Promise(done => srv.close(() => done())));
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { bare: origin, mounted: `${origin}/api/training-agent` };
}

beforeAll(async () => {
  ({ bare: bareBase, mounted: mountedBase } = await serveWithTransportCaps());
  unlimitedBase = await serve(true);
  rateLimitedBase = await serve(false);
});

afterAll(async () => {
  stopSessionCleanup();
  await Promise.all(closers.map(close => close()));
});

let rpcId = 0;
async function rpc(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/governance/creative-features/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...body }),
  });
  const text = await response.text();
  let json: Record<string, any> | undefined;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, headers: response.headers };
}

const manifestFor = (url: string) => ({
  provenance: { digital_source_type: 'digital_capture' },
  assets: { image: { asset_type: 'image', url } },
});

async function features(url: string) {
  const { status, json } = await rpc(unlimitedBase, {
    method: 'tools/call',
    params: { name: 'get_creative_features', arguments: { creative_manifest: manifestFor(url), feature_ids: ['ai_generated'] } },
  });
  const structured = json?.result?.structuredContent as { results?: Array<{ feature_id: string; value: unknown; confidence?: number }> } | undefined;
  return { status, structured };
}

describe('public creative-features verifier route', () => {
  it('answers with no Authorization header and flags only the "true" asset', async () => {
    const yes = await features(TRUE_ASSET);
    expect(yes.status).toBe(200);
    expect(yes.structured?.results).toEqual([{ feature_id: 'ai_generated', value: true, confidence: 0.95 }]);

    const no = await features(FALSE_ASSET);
    expect(no.status).toBe(200);
    expect(no.structured?.results).toEqual([{ feature_id: 'ai_generated', value: false, confidence: 0.95 }]);
  });

  it('is deterministic across repeated calls', async () => {
    const a = await features(TRUE_ASSET);
    const b = await features(TRUE_ASSET);
    expect(b.structured).toEqual(a.structured);
  });

  it('lists exactly one tool, get_creative_features', async () => {
    const { status, json } = await rpc(unlimitedBase, { method: 'tools/list' });
    expect(status).toBe(200);
    expect((json?.result?.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['get_creative_features']);
  });

  it('rejects every other tool', async () => {
    for (const name of ['get_products', 'sync_creatives', 'create_media_buy', 'get_adcp_capabilities']) {
      const { json } = await rpc(unlimitedBase, { method: 'tools/call', params: { name, arguments: {} } });
      expect(json?.result?.isError, name).toBe(true);
      expect(json?.result?.structuredContent?.adcp_error?.code, name).toBe('INVALID_REQUEST');
    }
  });

  it('rejects a call without creative_manifest', async () => {
    const { json } = await rpc(unlimitedBase, { method: 'tools/call', params: { name: 'get_creative_features', arguments: {} } });
    expect(json?.result?.isError).toBe(true);
    expect(json?.result?.structuredContent?.adcp_error?.field).toBe('creative_manifest');
  });

  it('rejects non-string feature_ids without leaking an engine error', async () => {
    const { json } = await rpc(unlimitedBase, {
      method: 'tools/call',
      params: { name: 'get_creative_features', arguments: { creative_manifest: manifestFor(TRUE_ASSET), feature_ids: { length: 1 } } },
    });
    expect(json?.result?.isError).toBe(true);
    expect(json?.result?.structuredContent?.adcp_error?.field).toBe('feature_ids');
  });

  it('names the public verifier URL in audit observations', async () => {
    const { json } = await rpc(unlimitedBase, {
      method: 'tools/call',
      params: {
        name: 'get_creative_features',
        arguments: {
          creative_manifest: {
            provenance: { digital_source_type: 'trained_algorithmic_media', human_oversight: 'directed', disclosure: { required: false } },
            assets: { image: { asset_type: 'image', url: TRUE_ASSET } },
          },
        },
      },
    });
    const observations = json?.result?.structuredContent?.audit_observations;
    expect(observations?.[0]?.code).toBe('OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED');
    expect(observations?.[0]?.details?.agent_url).toBe(VERIFIER_URL);
  });

  it('echoes context unchanged', async () => {
    const { json } = await rpc(unlimitedBase, {
      method: 'tools/call',
      params: { name: 'get_creative_features', arguments: { creative_manifest: manifestFor(TRUE_ASSET), context: { correlation_id: 'c-1' } } },
    });
    expect(json?.result?.structuredContent?.context).toEqual({ correlation_id: 'c-1' });
  });

  it('rejects GET with 405 and answers CORS preflight', async () => {
    const get = await fetch(`${unlimitedBase}/governance/creative-features/mcp`);
    expect(get.status).toBe(405);
    const options = await fetch(`${unlimitedBase}/governance/creative-features/mcp`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
  });

  it('is per-IP rate limited when limiting is enabled', async () => {
    const { headers } = await rpc(rateLimitedBase, { method: 'tools/list' });
    expect(headers.get('ratelimit-limit') ?? headers.get('ratelimit')).toBeTruthy();
  });

  it('does not change the bearer requirement on the governance tenant', async () => {
    const response = await fetch(`${unlimitedBase}/governance/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('transport body cap on every reachable spelling of the verifier', () => {
  const padded = (bytes: number) => ({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_creative_features', arguments: { creative_manifest: manifestFor(TRUE_ASSET), context: { pad: 'x'.repeat(bytes) } } },
  });
  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const spellings = (): Array<[string, string]> => [
    ['bare', `${bareBase}/governance/creative-features/mcp`],
    ['bare, trailing slash', `${bareBase}/governance/creative-features/mcp/`],
    ['bare, mixed case', `${bareBase}/Governance/Creative-Features/MCP`],
    ['mounted under /api/training-agent', `${mountedBase}/governance/creative-features/mcp`],
    ['mounted, trailing slash', `${mountedBase}/governance/creative-features/mcp/`],
  ];

  it('rejects a 20 KB body with 413 on every spelling', async () => {
    for (const [label, url] of spellings()) {
      expect((await post(url, padded(20_000))).status, label).toBe(413);
    }
  });

  it('accepts a body under the cap on every spelling', async () => {
    for (const [label, url] of spellings()) {
      const response = await post(url, padded(1_000));
      expect(response.status, label).toBe(200);
    }
  });

  it('leaves the 10 MB default on other training-agent paths', async () => {
    // A 20 KB body is rejected by the verifier cap above but must not hit a
    // body-size error on an authenticated tenant route (it fails auth instead).
    const response = await post(`${mountedBase}/governance/mcp`, padded(20_000));
    expect(response.status).toBe(401);
  });
});

describe('provenance storyboards use the public verifier and served fixtures', () => {
  for (const file of ['provenance_truth_of_claim.yaml', 'provenance_audit_observation.yaml']) {
    describe(file, () => {
      const raw = readFileSync(resolve(SCENARIOS, file), 'utf8');

      it('names the public verifier and no sentinel', () => {
        expect(raw).not.toContain('governance.encypher.seller.example');
        expect(raw).not.toMatch(/sentinel/i);
        expect(raw).toContain(`agent_url: "${VERIFIER_URL}"`);
        expect(raw).toContain('sellers MUST NOT\n    call a verifier URL that is not on their own allowlist.');
      });

      it('points assets at served paths that exist in static/', () => {
        expect(raw).not.toContain('test-assets.adcontextprotocol.org');
        const urls = [...raw.matchAll(/url: "(https:\/\/adcontextprotocol\.org\/test-assets\/[^"]+)"/g)].map(m => m[1]);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
          expect(existsSync(resolve(ROOT, 'static', new URL(url).pathname.slice(1))), url).toBe(true);
        }
      });
    });
  }

  it('accept_consistent_claim depends only on discover_verifier', () => {
    const doc = parseYaml(readFileSync(resolve(SCENARIOS, 'provenance_truth_of_claim.yaml'), 'utf8')) as {
      phases: Array<{ id: string; depends_on?: string[] }>;
    };
    expect(doc.phases.find(p => p.id === 'accept_consistent_claim')?.depends_on).toEqual(['discover_verifier']);
  });

  it('fixture JPEGs are real JPEGs marked as test fixtures', () => {
    for (const name of ['ai-generated-true.jpg', 'ai-generated-false.jpg']) {
      const bytes = readFileSync(resolve(ROOT, 'static/test-assets/acme-outdoor', name));
      expect(bytes.subarray(0, 3).toString('hex'), name).toBe('ffd8ff');
      expect(bytes.length, name).toBeLessThan(10_000);
      expect(bytes.toString('latin1'), name).toContain('AdCP TEST FIXTURE');
    }
  });
});
