import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AdAgentsManager } from '../../src/adagents-manager.js';
import type { AuthorizedAgent, AdAgentsJson } from '../../src/types.js';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('AdAgentsManager', () => {
  let manager: AdAgentsManager;

  beforeEach(() => {
    manager = new AdAgentsManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateDomain', () => {
    it('validates a valid adagents.json file', async () => {
      const validAdAgents: AdAgentsJson = {
        $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
        authorized_agents: [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test authorization scope',
          },
        ],
        last_updated: new Date().toISOString(),
      };

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: validAdAgents,
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.domain).toBe('example.com');
      expect(result.url).toBe('https://example.com/.well-known/adagents.json');
      expect(result.status_code).toBe(200);
    });

    it('normalizes domain by removing protocol', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('https://example.com');

      expect(result.domain).toBe('example.com');
      expect(result.url).toBe('https://example.com/.well-known/adagents.json');
    });

    it('normalizes domain by removing trailing slash', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com/');

      expect(result.domain).toBe('example.com');
    });

    it('detects missing adagents.json (404)', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 404,
        data: '<html>Not Found</html>',
        headers: { 'content-type': 'text/html' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('File not found');
      expect(result.raw_data).toBeUndefined(); // Don't include HTML error pages
    });

    it('handles network connection errors', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        code: 'ENOTFOUND',
      });
      mockedAxios.isAxiosError = vi.fn().mockReturnValue(true);

      const result = await manager.validateDomain('nonexistent.example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'connection')).toBe(true);
    });

    it('handles request timeout', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        code: 'ECONNABORTED',
      });
      mockedAxios.isAxiosError = vi.fn().mockReturnValue(true);

      const result = await manager.validateDomain('slow.example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'timeout')).toBe(true);
    });

    it('detects missing authorized_agents field', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authorized_agents')).toBe(true);
    });

    it('detects invalid authorized_agents type', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: 'not an array',
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must be an array'))).toBe(true);
    });

    it('warns about missing optional $schema field', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === '$schema')).toBe(true);
    });

    it('warns about missing last_updated field', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'last_updated')).toBe(true);
    });
  });

  describe('validateAgent', () => {
    it('validates required url field', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.url') && e.message.includes('required'))).toBe(true);
    });

    it('validates url is a valid URL', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'not-a-valid-url',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.url') && e.message.includes('valid URL'))).toBe(true);
    });

    it('requires HTTPS for agent URLs', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'http://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must use HTTPS'))).toBe(true);
    });

    it('validates required authorized_for field', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });

    it('validates authorized_for is not empty', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: '',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      // Empty string is treated as missing/required in JavaScript (falsy check)
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });

    it('validates authorized_for length constraint', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'a'.repeat(501),
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('500 characters or less'))).toBe(true);
    });

    it('validates property_ids is an array', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
              property_ids: 'not-an-array',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.property_ids') && e.message.includes('must be an array'))).toBe(true);
    });

    it('warns about duplicate agent URLs', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Scope 1',
            },
            {
              url: 'https://agent.example.com',
              authorized_for: 'Scope 2',
            },
          ],
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true); // Valid but with warning
      expect(result.warnings.some(w => w.message.includes('Duplicate agent URL'))).toBe(true);
    });
  });

  describe('validateAgentCards', () => {
    it('validates agent cards successfully', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          name: 'Test Agent',
          capabilities: ['media-buy'],
        },
        headers: { 'content-type': 'application/json' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(results[0].agent_url).toBe('https://agent.example.com');
      expect(results[0].card_endpoint).toBeDefined();
    });

    it('tries both standard and root endpoints', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      let callCount = 0;
      mockedAxios.get.mockImplementation((url) => {
        callCount++;
        if (url === 'https://agent.example.com/.well-known/agent-card.json') {
          return Promise.resolve({
            status: 404,
            data: {},
            headers: {},
          });
        }
        return Promise.resolve({
          status: 200,
          data: { name: 'Agent' },
          headers: { 'content-type': 'application/json' },
        });
      });

      const results = await manager.validateAgentCards(agents);

      expect(callCount).toBeGreaterThan(1);
      expect(results[0].valid).toBe(true);
    });

    it('detects missing agent cards', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedAxios.get.mockResolvedValue({
        status: 404,
        data: {},
        headers: {},
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      // Error is prefixed with A2A: since both protocols are tried
      expect(results[0].errors.some(e => e.includes('No agent card found'))).toBe(true);
    });

    it('detects wrong content-type for agent card', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { name: 'Agent' },
        headers: { 'content-type': 'text/plain' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some(e => e.includes('content-type'))).toBe(true);
    });

    it('detects HTML instead of JSON', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: '<html><body>Website</body></html>',
        headers: { 'content-type': 'text/html' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some(e => e.includes('HTML instead of JSON'))).toBe(true);
    });

    it('validates multiple agents in parallel', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent1.example.com',
          authorized_for: 'Test 1',
        },
        {
          url: 'https://agent2.example.com',
          authorized_for: 'Test 2',
        },
      ];

      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { name: 'Agent' },
        headers: { 'content-type': 'application/json' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results).toHaveLength(2);
      expect(results[0].agent_url).toBe('https://agent1.example.com');
      expect(results[1].agent_url).toBe('https://agent2.example.com');
    });
  });

  describe('createAdAgentsJson', () => {
    it('creates valid adagents.json with all options', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test authorization scope',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, true);
      const parsed = JSON.parse(json);

      expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v2/adagents.json');
      expect(parsed.authorized_agents).toEqual(agents);
      expect(parsed.last_updated).toBeDefined();
      expect(new Date(parsed.last_updated).toISOString()).toBe(parsed.last_updated);
    });

    it('creates adagents.json without schema', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, false, true);
      const parsed = JSON.parse(json);

      expect(parsed.$schema).toBeUndefined();
    });

    it('creates adagents.json without timestamp', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, false);
      const parsed = JSON.parse(json);

      expect(parsed.last_updated).toBeUndefined();
    });

    it('formats JSON with proper indentation', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, true);

      expect(json).toContain('  '); // Contains 2-space indentation
      expect(json.split('\n').length).toBeGreaterThan(1); // Multiple lines
    });
  });

  describe('URL Reference Support', () => {
    it('follows URL reference to authoritative file', async () => {
      const referenceData = {
        $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
        authoritative_location: 'https://cdn.example.com/adagents.json',
        last_updated: '2025-01-15T10:00:00Z'
      };

      const authoritativeData = {
        $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
        authorized_agents: [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test authorization',
          },
        ],
        last_updated: '2025-01-15T09:00:00Z'
      };

      let callCount = 0;
      mockedAxios.get.mockImplementation((url) => {
        callCount++;
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: referenceData,
            headers: { 'content-type': 'application/json' },
          });
        } else if (url === 'https://cdn.example.com/adagents.json') {
          return Promise.resolve({
            status: 200,
            data: authoritativeData,
            headers: { 'content-type': 'application/json' },
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await manager.validateDomain('example.com');

      expect(callCount).toBe(2); // Two requests: initial + authoritative
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects non-HTTPS authoritative locations', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authoritative_location: 'http://insecure.example.com/adagents.json',
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('HTTPS'))).toBe(true);
    });

    it('rejects invalid authoritative locations', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: {
          authoritative_location: 'not-a-valid-url',
        },
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('valid URL'))).toBe(true);
    });

    it('handles 404 from authoritative location', async () => {
      const referenceData = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: referenceData,
            headers: { 'content-type': 'application/json' },
          });
        } else {
          return Promise.resolve({
            status: 404,
            data: 'Not Found',
            headers: { 'content-type': 'text/html' },
          });
        }
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('File not found'))).toBe(true);
    });

    it('prevents nested URL references (infinite loop protection)', async () => {
      const referenceData1 = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      const referenceData2 = {
        authoritative_location: 'https://cdn2.example.com/adagents.json',
      };

      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: referenceData1,
            headers: { 'content-type': 'application/json' },
          });
        } else if (url === 'https://cdn.example.com/adagents.json') {
          return Promise.resolve({
            status: 200,
            data: referenceData2,
            headers: { 'content-type': 'application/json' },
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('nested references not allowed'))).toBe(true);
    });

    it('handles network errors fetching authoritative file', async () => {
      const referenceData = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: referenceData,
            headers: { 'content-type': 'application/json' },
          });
        } else {
          return Promise.reject({
            isAxiosError: true,
            message: 'Network error',
          });
        }
      });
      mockedAxios.isAxiosError = vi.fn().mockReturnValue(true);

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location')).toBe(true);
    });
  });

  describe('MCP Protocol Support', () => {
    it('falls back to MCP when A2A endpoints return 404', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://mcp-agent.example.com/mcp',
          authorized_for: 'Test',
        },
      ];

      // A2A endpoints return 404
      mockedAxios.get.mockResolvedValue({
        status: 404,
        data: {},
        headers: {},
      });

      // Mock MCP client
      vi.doMock('@adcp/client', () => ({
        AdCPClient: class {
          agent() {
            return {
              getAgentInfo: () =>
                Promise.resolve({
                  name: 'MCP Test Agent',
                  tools: [{ name: 'tool1' }, { name: 'tool2' }],
                }),
            };
          }
        },
      }));

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(true);
      expect(results[0].card_data?.protocol).toBe('mcp');
      expect(results[0].card_data?.tools_count).toBe(2);
    });

    it('returns combined errors when both A2A and MCP fail', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://broken-agent.example.com',
          authorized_for: 'Test',
        },
      ];

      // A2A endpoints return 404
      mockedAxios.get.mockResolvedValue({
        status: 404,
        data: {},
        headers: {},
      });

      // Mock MCP client to fail
      vi.doMock('@adcp/client', () => ({
        AdCPClient: class {
          agent() {
            return {
              getAgentInfo: () => Promise.reject(new Error('Connection refused')),
            };
          }
        },
      }));

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some((e) => e.includes('A2A'))).toBe(true);
      expect(results[0].errors.some((e) => e.includes('MCP'))).toBe(true);
    });
  });

  describe('validateProposed', () => {
    it('validates proposed agents without making HTTP requests', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test authorization scope',
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.domain).toBe('proposed');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('detects invalid agents in proposal', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'http://insecure.example.com', // HTTP not HTTPS
          authorized_for: 'Test',
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must use HTTPS'))).toBe(true);
    });

    it('detects empty authorized_for in proposal', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: '',
        },
      ];

      const result = manager.validateProposed(agents);

      // Empty string is treated as missing/required in JavaScript (falsy check)
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });
  });

  describe('Signals Support', () => {
    describe('validateSignal', () => {
      it('validates a valid binary signal', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'likely_tesla_buyers',
                name: 'Likely Tesla Buyers',
                value_type: 'binary',
                category: 'purchase_intent',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates a valid categorical signal', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'vehicle_ownership',
                name: 'Vehicle Ownership',
                value_type: 'categorical',
                allowed_values: ['tesla', 'bmw', 'mercedes'],
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates a valid numeric signal with range', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'purchase_propensity',
                name: 'Purchase Propensity Score',
                value_type: 'numeric',
                range: { min: 0, max: 100, unit: 'score' },
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('detects missing signal id', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                name: 'Missing ID Signal',
                value_type: 'binary',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].id' && e.message.includes('required'))).toBe(true);
      });

      it('detects invalid signal id pattern', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'invalid id with spaces',
                name: 'Invalid ID Signal',
                value_type: 'binary',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].id' && e.message.includes('alphanumeric'))).toBe(true);
      });

      it('detects missing signal name', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'test_signal',
                value_type: 'binary',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].name' && e.message.includes('required'))).toBe(true);
      });

      it('detects invalid value_type', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'invalid_type',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].value_type' && e.message.includes('binary, categorical, numeric'))).toBe(true);
      });

      it('warns about categorical signal without allowed_values', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'vehicle_type',
                name: 'Vehicle Type',
                value_type: 'categorical',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.field === 'signals[0].allowed_values')).toBe(true);
      });

      it('validates numeric signal range min > max', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'score',
                name: 'Score',
                value_type: 'numeric',
                range: { min: 100, max: 0 },
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].range' && e.message.includes('cannot be greater'))).toBe(true);
      });

      it('validates standard signal category', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 'purchase_intent',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.filter(w => w.field === 'signals[0].category')).toHaveLength(0);
      });

      it('warns about non-standard signal category', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 'my_custom_category',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.field === 'signals[0].category' && w.message.includes('not a standard category'))).toBe(true);
      });

      it('errors when signal category is not a string', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 123,
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].category' && e.message.includes('must be a string'))).toBe(true);
      });
    });

    describe('signal_tags validation', () => {
      it('validates valid signal_tags', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['automotive'] },
            ],
            signal_tags: {
              automotive: { name: 'Automotive', description: 'Vehicle-related signals' },
            },
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
      });

      it('warns about signal tags used but not defined', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['undefined_tag'] },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.message.includes('undefined_tag'))).toBe(true);
      });

      it('detects duplicate signal IDs', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test' },
            ],
            signals: [
              { id: 'duplicate_id', name: 'Signal 1', value_type: 'binary' },
              { id: 'duplicate_id', name: 'Signal 2', value_type: 'binary' },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true); // Warning, not error
        expect(result.warnings.some(w => w.message.includes('Duplicate signal ID'))).toBe(true);
      });
    });

    describe('signal authorization types', () => {
      it('validates signal_ids authorization type', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Automotive signals',
                authorization_type: 'signal_ids',
                signal_ids: ['likely_tesla_buyers'],
              },
            ],
            signals: [
              { id: 'likely_tesla_buyers', name: 'Likely Tesla Buyers', value_type: 'binary' },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates signal_tags authorization type', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'All automotive signals',
                authorization_type: 'signal_tags',
                signal_tags: ['automotive'],
              },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['automotive'] },
            ],
            signal_tags: {
              automotive: { name: 'Automotive', description: 'Vehicle signals' },
            },
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
      });

      it('warns when signal_ids authorization has no matching signals', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                authorization_type: 'signal_ids',
                signal_ids: ['nonexistent_signal'],
              },
            ],
            signals: [
              { id: 'actual_signal', name: 'Actual Signal', value_type: 'binary' },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.message.includes('nonexistent_signal'))).toBe(true);
      });

      it('warns when signal_ids authorization type but no signal_ids array', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                authorization_type: 'signal_ids',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.message.includes('signal_ids') && w.message.includes('no signal_ids provided'))).toBe(true);
      });

      it('errors when signal_ids is not an array', async () => {
        mockedAxios.get.mockResolvedValue({
          status: 200,
          data: {
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                signal_ids: 'not-an-array',
              },
            ],
          },
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field.includes('.signal_ids') && e.message.includes('must be an array'))).toBe(true);
      });
    });

    describe('createAdAgentsJson with signals', () => {
      it('creates adagents.json with signals', () => {
        const agents: AuthorizedAgent[] = [
          {
            url: 'https://agent.example.com',
            authorized_for: 'All Polk automotive signals',
            authorization_type: 'signal_tags',
            signal_tags: ['automotive'],
          },
        ];

        const signals = [
          {
            id: 'likely_tesla_buyers',
            name: 'Likely Tesla Buyers',
            value_type: 'binary' as const,
            category: 'purchase_intent',
            tags: ['automotive'],
          },
        ];

        const signalTags = {
          automotive: { name: 'Automotive', description: 'Vehicle-related signals' },
        };

        const json = manager.createAdAgentsJson(agents, true, true, undefined, signals, signalTags);
        const parsed = JSON.parse(json);

        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0].id).toBe('likely_tesla_buyers');
        expect(parsed.signal_tags).toBeDefined();
        expect(parsed.signal_tags.automotive.name).toBe('Automotive');
      });

      it('creates adagents.json without signals when not provided', () => {
        const agents: AuthorizedAgent[] = [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test',
          },
        ];

        const json = manager.createAdAgentsJson(agents, true, true);
        const parsed = JSON.parse(json);

        expect(parsed.signals).toBeUndefined();
        expect(parsed.signal_tags).toBeUndefined();
      });

      it('creates adagents.json using options object', () => {
        const json = manager.createAdAgentsJson({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'All signals',
              authorization_type: 'signal_tags',
              signal_tags: ['automotive'],
            },
          ],
          signals: [
            {
              id: 'likely_ev_buyers',
              name: 'Likely EV Buyers',
              value_type: 'binary',
              category: 'purchase_intent',
              tags: ['automotive'],
            },
          ],
          signalTags: {
            automotive: { name: 'Automotive', description: 'Vehicle signals' },
          },
          includeSchema: true,
          includeTimestamp: false,
        });
        const parsed = JSON.parse(json);

        expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v2/adagents.json');
        expect(parsed.last_updated).toBeUndefined();
        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0].id).toBe('likely_ev_buyers');
        expect(parsed.signal_tags.automotive.name).toBe('Automotive');
      });

      it('options object includeSchema defaults to true', () => {
        const json = manager.createAdAgentsJson({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        });
        const parsed = JSON.parse(json);

        expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v2/adagents.json');
        expect(parsed.last_updated).toBeDefined();
      });
    });
  });
});
