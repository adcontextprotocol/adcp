import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/pg-rate-limit-store.js', async () => {
  const { MemoryStore } = await import('express-rate-limit');
  return { CachedPostgresStore: class extends MemoryStore {
    constructor(_prefix: string) { super(); }
  } };
});
vi.mock('@modelcontextprotocol/sdk/server/auth/router.js', () => ({
  mcpAuthRouter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js', () => ({
  requireBearerAuth: () => (req: express.Request & { auth?: unknown }, _res: express.Response, next: express.NextFunction) => {
    req.auth = { token: req.headers.authorization };
    next();
  },
}));
vi.mock('../../src/mcp/oauth-provider.js', () => ({
  MCP_AUTH_ENABLED: true,
  createOAuthProvider: () => ({}),
}));
vi.mock('../../src/mcp/auth.js', () => ({
  authInfoToMCPAuthContext: (auth: { token: string }) => ({ sub: auth.token, isM2M: false, payload: {} }),
  anonymousAuthContext: () => ({ sub: 'anonymous', isM2M: false, payload: {} }),
}));
vi.mock('../../src/mcp/principal-authorization.js', () => ({
  authorizeMCPPrincipal: async () => ({ authorized: true }),
}));
vi.mock('../../src/mcp/server.js', () => ({
  createUnifiedMCPServer: () => ({ connect: async () => {}, close: async () => {} }),
}));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(req: express.Request, res: express.Response) {
      res.status(200).json({ jsonrpc: '2.0', id: req.body.id, result: {} });
    }
  },
}));

import { configureMCPRoutes } from '../../src/mcp/routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  configureMCPRoutes(router);
  app.use(router);
  return app;
}

describe('MCP transport rate limiting', () => {
  it('allows connection setup and discovery across repeated connector attempts', async () => {
    const app = createApp();
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const method of ['initialize', 'notifications/initialized', 'tools/list']) {
        const response = await request(app).post('/mcp').set('Authorization', 'Bearer setup-user').send({ jsonrpc: '2.0', method });
        expect(response.status).toBe(200);
      }
    }
  });

  it('returns a correlated 429 with a readable retry delay and isolates principals', async () => {
    const app = createApp();
    for (let id = 1; id <= 60; id++) {
      const response = await request(app).post('/mcp').set('Authorization', 'Bearer busy-user')
        .send({ jsonrpc: '2.0', id, method: 'tools/call' });
      expect(response.status).toBe(200);
    }
    const limited = await request(app).post('/mcp').set('Authorization', 'Bearer busy-user')
      .send({ jsonrpc: '2.0', id: 'validation-request', method: 'tools/call' });
    expect(limited.status).toBe(429);
    expect(limited.body.id).toBe('validation-request');
    expect(limited.body.error.data.retry_after).toBe(Number(limited.headers['retry-after']));
    expect(limited.body.error.data.retry_after).toBeGreaterThan(0);
    expect(limited.headers['access-control-expose-headers']).toContain('Retry-After');

    expect((await request(app).post('/mcp').set('Authorization', 'Bearer other-user')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  });
});
