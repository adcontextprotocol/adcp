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
      expect(result.errors[0].message).toContain('HTTP 404');
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
      expect(results[0].errors).toContain('No agent card found at /.well-known/agent-card.json or root URL');
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
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('HTTP 404'))).toBe(true);
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
});
