import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { FeedError, FeedResult } from '../../src/db/catalog-events-db.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/middleware/rate-limit.js', () => {
  const pass: import('express').RequestHandler = (_req, _res, next) => next();
  return {
    bulkResolveRateLimiter: pass,
    brandCreationRateLimiter: pass,
    storyboardEvalRateLimiter: pass,
    storyboardStepRateLimiter: pass,
    agentReadRateLimiter: pass,
    registryPublisherRateLimiter: pass,
    registryReadRateLimiter: pass,
  };
});

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function makeFeed(overrides: Partial<FeedResult> = {}): FeedResult {
  return {
    events: [],
    cursor: '019539a0-1234-7000-8000-000000000001',
    has_more: false,
    freshness: {
      generated_at: '2026-03-31T10:00:15.000Z',
      latest_event_created_at: '2026-03-31T10:00:00.000Z',
      lag_seconds: 15,
      retention_days: 90,
    },
    ...overrides,
  };
}

function makeApp(queryFeed: RegistryApiConfig['eventsDb']['queryFeed']) {
  const app = express();
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const config: RegistryApiConfig = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    eventsDb: { queryFeed },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  };

  app.use('/api', createRegistryApiRouter(config));
  return app;
}

function parseSseFrames(text: string): Array<{ event: string; data: unknown }> {
  return text.trim().split(/\n\n+/).filter(Boolean).map(frame => {
    const eventLine = frame.split('\n').find(line => line.startsWith('event: '));
    const dataLines = frame.split('\n').filter(line => line.startsWith('data: '));
    if (!eventLine || dataLines.length === 0) {
      throw new Error(`Invalid SSE frame: ${frame}`);
    }
    return {
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLines.map(line => line.slice('data: '.length)).join('\n')),
    };
  });
}

async function readFirstSseFrame(app: express.Express, path: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
      server.close();
    };

    const req = http.get({ hostname: '127.0.0.1', port, path }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.includes('\n\n')) {
          finish(() => {
            req.destroy();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, text });
          });
        }
      });
      res.on('error', error => finish(() => reject(error)));
    });

    req.setTimeout(1000, () => {
      finish(() => {
        req.destroy();
        reject(new Error('Timed out waiting for SSE frame'));
      });
    });
    req.on('error', error => {
      if (!settled) finish(() => reject(error));
    });
  });
}

describe('GET /api/registry/feed/stream', () => {
  it('rejects invalid stream query params before opening the SSE stream', async () => {
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>();
    const app = makeApp(queryFeed);

    const res = await request(app).get('/api/registry/feed/stream?cursor=not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid cursor format/);
    expect(queryFeed).not.toHaveBeenCalled();
  });

  it.each([
    ['limit', '0', /limit must be between 1 and 10000/],
    ['limit', '10001', /limit must be between 1 and 10000/],
    ['limit', '1abc', /limit must be an integer/],
    ['poll_interval_seconds', '4', /poll_interval_seconds must be between 5 and 60/],
    ['poll_interval_seconds', '61', /poll_interval_seconds must be between 5 and 60/],
    ['poll_interval_seconds', '5abc', /poll_interval_seconds must be an integer/],
  ])('rejects invalid %s=%s before opening the SSE stream', async (param, value, message) => {
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>();
    const app = makeApp(queryFeed);

    const res = await request(app).get(`/api/registry/feed/stream?${param}=${encodeURIComponent(value)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(queryFeed).not.toHaveBeenCalled();
  });

  it('returns 410 JSON when the initial cursor is expired', async () => {
    const expired: FeedError = { error: 'cursor_expired', message: 'expired' };
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>().mockResolvedValue(expired);
    const app = makeApp(queryFeed);

    const res = await request(app).get('/api/registry/feed/stream?cursor=019539a0-1234-7000-8000-000000000001');

    expect(res.status).toBe(410);
    expect(res.body).toEqual(expired);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('streams feed pages and emits a terminal SSE error after headers are sent', async () => {
    const firstPage = makeFeed({
      events: [{
        event_id: '019539a0-1234-7000-8000-000000000002',
        event_type: 'property.created',
        entity_type: 'property',
        entity_id: 'property-1',
        payload: { property_rid: 'property-1' },
        actor: 'test',
        created_at: new Date('2026-03-31T10:00:00.000Z'),
      }],
      cursor: '019539a0-1234-7000-8000-000000000002',
      has_more: true,
    });
    const expired: FeedError = { error: 'cursor_expired', message: 'expired' };
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(expired);
    const app = makeApp(queryFeed);

    const res = await request(app).get('/api/registry/feed/stream?types=property.*&limit=1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toContain('no-cache');
    const frames = parseSseFrames(res.text);
    expect(frames).toEqual([
      expect.objectContaining({
        event: 'feed',
        data: expect.objectContaining({
          events: [expect.objectContaining({ event_type: 'property.created' })],
          cursor: '019539a0-1234-7000-8000-000000000002',
          freshness: firstPage.freshness,
        }),
      }),
      { event: 'error', data: expired },
    ]);
    expect(queryFeed).toHaveBeenNthCalledWith(1, null, ['property.*'], 1);
    expect(queryFeed).toHaveBeenNthCalledWith(2, '019539a0-1234-7000-8000-000000000002', ['property.*'], 1);
  });

  it('emits feed_stream_error when querying throws after headers are sent', async () => {
    const firstPage = makeFeed({
      events: [{
        event_id: '019539a0-1234-7000-8000-000000000003',
        event_type: 'property.updated',
        entity_type: 'property',
        entity_id: 'property-2',
        payload: { property_rid: 'property-2' },
        actor: 'test',
        created_at: new Date('2026-03-31T10:00:00.000Z'),
      }],
      cursor: '019539a0-1234-7000-8000-000000000003',
      has_more: true,
    });
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('db down'));
    const app = makeApp(queryFeed);

    const res = await request(app).get('/api/registry/feed/stream?limit=1');

    expect(res.status).toBe(200);
    const frames = parseSseFrames(res.text);
    expect(frames).toEqual([
      expect.objectContaining({ event: 'feed' }),
      {
        event: 'error',
        data: { error: 'feed_stream_error', message: 'Failed to query registry feed' },
      },
    ]);
  });

  it('emits heartbeat with freshness while caught up and closes without another query', async () => {
    const caughtUp = makeFeed({
      events: [],
      cursor: '019539a0-1234-7000-8000-000000000010',
      has_more: false,
    });
    const queryFeed = vi.fn<RegistryApiConfig['eventsDb']['queryFeed']>().mockResolvedValue(caughtUp);
    const app = makeApp(queryFeed);

    const res = await readFirstSseFrame(app, '/api/registry/feed/stream?types=property.*&limit=1&poll_interval_seconds=5');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const [frame] = parseSseFrames(res.text);
    expect(frame).toEqual({
      event: 'heartbeat',
      data: {
        generated_at: caughtUp.freshness.generated_at,
        cursor: caughtUp.cursor,
        freshness: caughtUp.freshness,
      },
    });
    expect(queryFeed).toHaveBeenCalledTimes(1);
    expect(queryFeed).toHaveBeenCalledWith(null, ['property.*'], 1);
  });
});
