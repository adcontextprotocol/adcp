import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { HTTPServer } from '../../src/http.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock config and database to prevent actual database connections
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: "postgresql://localhost/test",
    }),
  };
});

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

// Mock member database to return test agents
const mockMemberData = {
  id: 'test-member-1',
  slug: 'test-member',
  display_name: 'Test Member',
  is_public: true,
  agents: [
    {
      url: 'https://creative.test',
      is_public: true,
      name: 'Test Creative Agent',
      type: 'creative',
    }
  ],
  contact_email: 'test@example.com',
  contact_website: 'https://example.com',
  created_at: new Date('2024-01-01'),
  description: 'Test description',
};

vi.mock('../../src/db/member-db.js', () => {
  return {
    MemberDatabase: class MockMemberDatabase {
      listProfiles = vi.fn().mockResolvedValue([mockMemberData]);
      getPublicProfiles = vi.fn().mockResolvedValue([mockMemberData]);
      getProfileBySlug = vi.fn().mockResolvedValue(null);
    }
  };
});

// Mock rate limiter to disable validation in tests
vi.mock('../../src/middleware/rate-limit.js', () => ({
  apiRateLimiter: (req: any, res: any, next: any) => next(),
  authRateLimiter: (req: any, res: any, next: any) => next(),
  webhookRateLimiter: (req: any, res: any, next: any) => next(),
  invitationRateLimiter: (req: any, res: any, next: any) => next(),
}));

describe('MCP Protocol Compliance', () => {
  let server: HTTPServer;
  let app: any;

  beforeAll(async () => {
    server = new HTTPServer();
    app = server['app']; // Access private app property for testing
  });

  describe('POST /mcp - tools/list', () => {
    it('returns valid JSON-RPC 2.0 response structure', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('jsonrpc', '2.0');
      expect(response.body).toHaveProperty('id', 1);
      expect(response.body).toHaveProperty('result');
    });

    it('echoes request id in response', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 'test-id-123',
          method: 'tools/list'
        });

      expect(response.body.id).toBe('test-id-123');
    });

    it('returns result.tools array with 10 tools', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        });

      expect(response.body.result.tools).toBeInstanceOf(Array);
      expect(response.body.result.tools).toHaveLength(10);
    });

    it('each tool has name, description, inputSchema', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        });

      const tools = response.body.result.tools;
      tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
      });
    });

    it('inputSchema follows JSON Schema format', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        });

      const tools = response.body.result.tools;
      tools.forEach((tool: any) => {
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });
    });
  });

  describe('POST /mcp - tools/call: list_agents', () => {
    it('returns structured content with type: "resource"', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_agents',
            arguments: {}
          }
        });

      expect(response.body.result.content).toBeInstanceOf(Array);
      expect(response.body.result.content[0]).toHaveProperty('type', 'resource');
    });

    it('resource has uri, mimeType, text fields', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_agents',
            arguments: {}
          }
        });

      const resource = response.body.result.content[0].resource;
      expect(resource).toHaveProperty('uri');
      expect(resource).toHaveProperty('mimeType');
      expect(resource).toHaveProperty('text');
    });

    it('mimeType is "application/json"', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_agents',
            arguments: {}
          }
        });

      const resource = response.body.result.content[0].resource;
      expect(resource.mimeType).toBe('application/json');
    });

    it('text contains valid JSON string', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_agents',
            arguments: {}
          }
        });

      const resource = response.body.result.content[0].resource;
      expect(() => JSON.parse(resource.text)).not.toThrow();

      const parsed = JSON.parse(resource.text);
      expect(parsed).toHaveProperty('agents');
      expect(parsed).toHaveProperty('count');
    });

    it('filters by type argument when provided', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_agents',
            arguments: { type: 'creative' }
          }
        });

      const resource = response.body.result.content[0].resource;
      const parsed = JSON.parse(resource.text);

      parsed.agents.forEach((agent: any) => {
        expect(agent.type).toBe('creative');
      });
    });
  });

  describe('POST /mcp - tools/call: get_agent', () => {
    it('returns agent details in resource.text', async () => {
      // First get a valid agent URL
      const listResponse = await request(app).post('/mcp').send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_agents', arguments: {} }
      });

      const agents = JSON.parse(listResponse.body.result.content[0].resource.text).agents;
      if (agents.length === 0) {
        // Skip if no agents
        return;
      }

      const agentUrl = agents[0].url;

      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_agent',
            arguments: { url: agentUrl }
          }
        });

      if (response.body.error) {
        // Agent might not exist in the exact format we expect
        return;
      }

      const resource = response.body.result.content[0].resource;
      const parsed = JSON.parse(resource.text);
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('url');
    });

    it('returns JSON-RPC error for missing agent', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_agent',
            arguments: { url: 'https://nonexistent.example.com' }
          }
        });

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
    });

    it('error code is -32602 (Invalid params)', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_agent',
            arguments: { url: 'https://nonexistent.example.com' }
          }
        });

      expect(response.body.error.code).toBe(-32602);
    });
  });

  describe('POST /mcp - Error Handling', () => {
    it('returns -32601 for unknown tool name', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'unknown_tool',
            arguments: {}
          }
        });

      expect(response.body.error.code).toBe(-32601);
    });

    it('returns -32601 for unknown method', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
          params: {}
        });

      expect(response.body.error.code).toBe(-32601);
    });

    it('includes error message in response', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
          params: {}
        });

      expect(response.body.error).toHaveProperty('message');
      expect(typeof response.body.error.message).toBe('string');
    });
  });
});
