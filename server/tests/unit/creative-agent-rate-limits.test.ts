import express from 'express';
import type { Express, Router } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SETTINGS = [
  'CREATIVE_AGENT_MCP_RATE_LIMIT_MAX',
  'CREATIVE_AGENT_MCP_RATE_LIMIT_WINDOW_MS',
  'CREATIVE_AGENT_PREVIEW_ASSET_RATE_LIMIT_MAX',
  'CREATIVE_AGENT_PREVIEW_ASSET_RATE_LIMIT_WINDOW_MS',
] as const;
const TOKEN = 'creative-rate-limit-test';
let createCreativeAgentRouter: () => Router;

beforeAll(async () => {
  vi.stubEnv('CREATIVE_AGENT_TOKEN', TOKEN);
  try {
    ({ createCreativeAgentRouter } = await import('../../src/creative-agent/index.js'));
  } finally {
    vi.unstubAllEnvs();
  }
});

beforeEach(() => {
  for (const name of SETTINGS) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/creative-agent', createCreativeAgentRouter());
  return instance;
}

function initialize(instance: Express) {
  return request(instance).post('/api/creative-agent/mcp')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rate-limit-test', version: '1.0.0' },
      },
    });
}

function preview(instance: Express) {
  return request(instance).get('/api/creative-agent/preview-assets/missing-token');
}

describe('reference creative agent rate limits', () => {
  it('keeps the public defaults of 60 MCP requests and 30 preview-asset requests', async () => {
    const instance = app();
    for (let i = 0; i < 60; i++) expect((await initialize(instance)).status).toBe(200);
    const limited = await initialize(instance);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe(-32000);
    expect(limited.headers['ratelimit-policy']).toBe('60;w=60');

    for (let i = 0; i < 30; i++) expect((await preview(instance)).status).toBe(404);
    const assetLimited = await preview(instance);
    expect(assetLimited.status).toBe(429);
    expect(assetLimited.headers['ratelimit-policy']).toBe('30;w=60');
  });

  it('applies independent configured request limits', async () => {
    vi.stubEnv(SETTINGS[0], '2');
    vi.stubEnv(SETTINGS[2], '3');
    const instance = app();
    for (let i = 0; i < 2; i++) expect((await initialize(instance)).status).toBe(200);
    expect((await initialize(instance)).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await preview(instance)).status).toBe(404);
    expect((await preview(instance)).status).toBe(429);
  });

  it('allows test deployments to raise both limits above the public defaults', async () => {
    vi.stubEnv(SETTINGS[0], '61');
    vi.stubEnv(SETTINGS[2], '31');
    const instance = app();
    for (let i = 0; i < 61; i++) expect((await initialize(instance)).status).toBe(200);
    expect((await initialize(instance)).status).toBe(429);
    for (let i = 0; i < 31; i++) expect((await preview(instance)).status).toBe(404);
    expect((await preview(instance)).status).toBe(429);
  });

  it('resets each configured window independently', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.stubEnv(SETTINGS[0], '1');
    vi.stubEnv(SETTINGS[1], '1000');
    vi.stubEnv(SETTINGS[2], '1');
    vi.stubEnv(SETTINGS[3], '2000');
    const instance = app();
    expect((await initialize(instance)).status).toBe(200);
    expect((await preview(instance)).status).toBe(404);
    expect((await initialize(instance)).status).toBe(429);
    expect((await preview(instance)).status).toBe(429);
    vi.advanceTimersByTime(1001);
    expect((await initialize(instance)).status).toBe(200);
    expect((await preview(instance)).status).toBe(429);
    vi.advanceTimersByTime(1000);
    expect((await preview(instance)).status).toBe(404);
  });

  it('keeps forwarded headers from bypassing the default client-IP policy', async () => {
    vi.stubEnv(SETTINGS[0], '1');
    vi.stubEnv(SETTINGS[2], '1');
    const instance = app();
    expect((await initialize(instance).set('X-Forwarded-For', '192.0.2.1')).status).toBe(200);
    expect((await initialize(instance).set('X-Forwarded-For', '192.0.2.2')).status).toBe(429);
    expect((await preview(instance).set('X-Forwarded-For', '192.0.2.1')).status).toBe(404);
    expect((await preview(instance).set('X-Forwarded-For', '192.0.2.2')).status).toBe(429);
  });

  for (const name of SETTINGS) {
    it.each(['', '0', '-1', '1.5', '1e3', '0x10', ' 60', '60 ', '60ms', 'NaN', 'Infinity', '9007199254740992'])(
      `refuses invalid ${name}=%j when constructing the router`,
      value => {
        vi.stubEnv(name, value);
        expect(() => createCreativeAgentRouter()).toThrow(name);
      },
    );
  }

  for (const name of [SETTINGS[1], SETTINGS[3]]) {
    it(`refuses ${name} beyond Node's timer range`, () => {
      vi.stubEnv(name, '2147483648');
      expect(() => createCreativeAgentRouter()).toThrow(name);
    });
  }

  it('accepts the documented upper bounds', async () => {
    vi.stubEnv(SETTINGS[0], String(Number.MAX_SAFE_INTEGER));
    vi.stubEnv(SETTINGS[1], '2147483647');
    vi.stubEnv(SETTINGS[2], String(Number.MAX_SAFE_INTEGER));
    vi.stubEnv(SETTINGS[3], '2147483647');
    expect((await request(app()).get('/api/creative-agent/health')).status).toBe(200);
  });
});
