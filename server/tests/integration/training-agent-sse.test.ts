import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { EventSource } from 'eventsource';

// Set token before module loads (constantTimeEqual reads it at import time)
vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-sse';
});

// Suppress noisy logs during tests
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Dynamic import after env is set
const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

const AUTH = 'Bearer test-token-for-sse';

describe('Training Agent SSE Transport', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  // ── SSE error handling ────────────────────────────────────────────

  it('GET /sse without auth returns 401', async () => {
    await request(app)
      .get('/api/training-agent/sse')
      .expect(401);
  });

  it('POST /message without sessionId returns 400', async () => {
    const res = await request(app)
      .post('/api/training-agent/message')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(400);

    expect(res.body.error.message).toMatch(/sessionId/i);
  });

  it('POST /message with unknown sessionId returns 404', async () => {
    const res = await request(app)
      .post('/api/training-agent/message?sessionId=nonexistent')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(404);

    expect(res.body.error.message).toMatch(/not found/i);
  });

  it('OPTIONS /sse returns 204 with CORS headers', async () => {
    const res = await request(app)
      .options('/api/training-agent/sse')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('OPTIONS /message returns 204 with CORS headers', async () => {
    const res = await request(app)
      .options('/api/training-agent/message')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  // ── Full SSE round-trip ──────────────────────────────────────────

  describe('SSE round-trip', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;
      baseUrl = `http://localhost:${port}/api/training-agent`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('establishes SSE connection and receives endpoint event', async () => {
      const endpointUrl = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSE connection timeout')), 5000);
        const es = new EventSource(`${baseUrl}/sse`, {
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), Authorization: AUTH },
          }),
        });

        es.addEventListener('endpoint', (event) => {
          clearTimeout(timeout);
          es.close();
          resolve(event.data);
        });

        es.addEventListener('error', (err) => {
          clearTimeout(timeout);
          es.close();
          reject(new Error(`SSE error: ${err.message}`));
        });
      });

      expect(endpointUrl).toContain('/message');
      expect(endpointUrl).toContain('sessionId=');
    });

    it('accepts POST /message for an active SSE session', async () => {
      // Establish SSE connection
      let es: EventSource;
      const endpointUrl = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSE connection timeout')), 5000);
        es = new EventSource(`${baseUrl}/sse`, {
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), Authorization: AUTH },
          }),
        });

        es.addEventListener('endpoint', (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        });

        es.addEventListener('error', (err) => {
          clearTimeout(timeout);
          es.close();
          reject(new Error(`SSE error: ${err.message}`));
        });
      });

      try {
        const messageUrl = endpointUrl.startsWith('http')
          ? endpointUrl
          : `http://localhost:${(server.address() as any).port}${endpointUrl}`;

        const res = await fetch(messageUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: AUTH,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });

        // SSE transport returns 202 Accepted for messages
        expect(res.status).toBe(202);
      } finally {
        es!.close();
      }
    });
  });
});
