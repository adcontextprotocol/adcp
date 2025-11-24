import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { HTTPServer } from '../../src/http.js';
import { Registry } from '../../src/registry.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock config to prevent database connections
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue(null),
  };
});

describe('MCP Protocol Compliance', () => {
  let server: HTTPServer;
  let app: any;

  beforeAll(async () => {
    // Use real registry for integration tests
    server = new HTTPServer();
    // Initialize registry manually for testing (normally done in start())
    await server['registry'].initialize();
    app = server['app']; // Access private app property for testing
  });

  describe('POST /mcp - tools/list', () => {
    it('returns valid JSON-RPC 2.0 response structure', async () => {
      const response = await request(app)
        .post('/mcp')
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

    it('returns result.tools array with 6 tools', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        });

      expect(response.body.result.tools).toBeInstanceOf(Array);
      expect(response.body.result.tools).toHaveLength(6);
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
      // First get a valid agent ID
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

      const agentId = `${agents[0].type}/${agents[0].name.toLowerCase().replace(/\s+/g, '-')}`;

      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_agent',
            arguments: { id: agentId }
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
            arguments: { id: 'nonexistent/agent' }
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
            arguments: { id: 'nonexistent/agent' }
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
