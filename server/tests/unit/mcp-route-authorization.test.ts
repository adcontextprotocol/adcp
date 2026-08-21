import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  authorize: vi.fn(),
  createServer: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  default: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mocks.events.push('rate-limit');
    next();
  }),
}));

vi.mock('../../src/middleware/pg-rate-limit-store.js', () => ({
  CachedPostgresStore: class {},
}));

vi.mock('@modelcontextprotocol/sdk/server/auth/router.js', () => ({
  mcpAuthRouter: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js', () => ({
  requireBearerAuth: vi.fn(() => (req: express.Request & { auth?: unknown }, _res: express.Response, next: express.NextFunction) => {
    mocks.events.push('bearer');
    req.auth = { token: 'validated' };
    next();
  }),
}));

vi.mock('../../src/mcp/oauth-provider.js', () => ({
  MCP_AUTH_ENABLED: true,
  createOAuthProvider: vi.fn(() => ({})),
}));

vi.mock('../../src/mcp/auth.js', () => ({
  authInfoToMCPAuthContext: vi.fn(() => ({ sub: 'user_123', orgId: 'org_123', isM2M: false, payload: {} })),
  anonymousAuthContext: vi.fn(() => ({ sub: 'anonymous', isM2M: false, payload: {} })),
}));

vi.mock('../../src/mcp/principal-authorization.js', () => ({
  authorizeMCPPrincipal: vi.fn(async (...args: unknown[]) => {
    mocks.events.push('authorize');
    return mocks.authorize(...args);
  }),
}));

vi.mock('../../src/mcp/server.js', () => ({
  createUnifiedMCPServer: vi.fn((...args: unknown[]) => {
    mocks.createServer(...args);
    return { connect: mocks.connect, close: mocks.close };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(_req: express.Request, res: express.Response) {
      res.status(200).json({ ok: true });
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.authorize.mockResolvedValue({ authorized: true });
  mocks.connect.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
});

describe('MCP route principal authorization', () => {
  it('rate-limits before mutable authority checks and never reaches tools on denial', async () => {
    mocks.authorize.mockResolvedValue({ authorized: false, reason: 'platform_banned' });

    const response = await request(createApp()).post('/mcp').send({ method: 'tools/list' });

    expect(response.status).toBe(403);
    expect(mocks.events).toEqual(['bearer', 'rate-limit', 'authorize']);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when an authorization dependency fails', async () => {
    mocks.authorize.mockRejectedValue(new Error('WorkOS unavailable'));

    const response = await request(createApp()).post('/mcp').send({ method: 'tools/call' });

    expect(response.status).toBe(503);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('passes only the authorized principal to the MCP server', async () => {
    const response = await request(createApp()).post('/mcp').send({ method: 'tools/list' });

    expect(response.status).toBe(200);
    expect(mocks.createServer).toHaveBeenCalledWith(expect.objectContaining({
      sub: 'user_123',
      orgId: 'org_123',
    }));
  });
});
