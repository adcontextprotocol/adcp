/**
 * Tests for tools exposed on the /mcp endpoint.
 *
 * Verifies that:
 * - Tool definitions are correctly extracted from internal tool arrays
 * - Each tool has proper MCP-format schema
 * - Handler factories create callable handlers
 * - Auth-required tools reject anonymous callers
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as hostnameVerification from '../../src/services/agent-hostname-verification.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import * as clientDb from '../../src/db/client.js';
import {
  EVAL_TOOL_DEFINITIONS,
  AGENT_CONTEXT_TOOL_DEFINITIONS,
  SCHEMA_TOOL_DEFINITIONS,
  PROPERTY_TOOL_DEFINITIONS,
  ALL_EXPOSED_TOOL_DEFINITIONS,
  createMemberToolHandler,
  createStatelessToolHandlers,
} from '../../src/mcp/exposed-tools.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function savedAgentContext(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx_123',
    organization_id: 'org_123',
    agent_url: 'https://agent.example.com/mcp',
    agent_name: null,
    agent_type: 'unknown',
    protocol: 'mcp',
    has_auth_token: false,
    auth_token_hint: null,
    auth_type: 'bearer',
    has_oauth_token: false,
    has_oauth_refresh_token: false,
    oauth_token_expires_at: null,
    has_oauth_client: false,
    has_oauth_client_credentials: false,
    tools_discovered: null,
    last_discovered_at: null,
    last_test_scenario: null,
    last_test_passed: null,
    last_test_summary: null,
    last_tested_at: null,
    total_tests_run: 0,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    created_by: 'user_123',
    ...overrides,
  } as any;
}

describe('EVAL_TOOL_DEFINITIONS', () => {
  const EXPECTED = [
    'get_agent_status',
    'evaluate_agent_quality',
    'test_rfp_response',
    'test_io_execution',
  ];

  it('exports exactly the 4 evaluation tools', () => {
    const names = EVAL_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED));
    expect(names).toHaveLength(EXPECTED.length);
  });

  it('each tool has name, description, and inputSchema', () => {
    for (const tool of EVAL_TOOL_DEFINITIONS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    }
  });

  it('all tools require agent_url', () => {
    for (const tool of EVAL_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.required).toContain('agent_url');
    }
  });

  it('test_rfp_response requires rfp parameter', () => {
    const tool = EVAL_TOOL_DEFINITIONS.find((t) => t.name === 'test_rfp_response');
    expect(tool!.inputSchema.required).toContain('rfp');
  });

  it('test_io_execution requires line_items parameter', () => {
    const tool = EVAL_TOOL_DEFINITIONS.find((t) => t.name === 'test_io_execution');
    expect(tool!.inputSchema.required).toContain('line_items');
  });

  it('evaluate_agent_quality has tracks param', () => {
    const tool = EVAL_TOOL_DEFINITIONS.find((t) => t.name === 'evaluate_agent_quality');
    expect(tool!.inputSchema.properties).toHaveProperty('tracks');
  });
});

describe('AGENT_CONTEXT_TOOL_DEFINITIONS', () => {
  const EXPECTED = ['save_agent', 'list_saved_agents', 'remove_saved_agent'];

  it('exports exactly the 3 agent context tools', () => {
    const names = AGENT_CONTEXT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED));
    expect(names).toHaveLength(EXPECTED.length);
  });

  it('save_agent requires agent_url', () => {
    const tool = AGENT_CONTEXT_TOOL_DEFINITIONS.find((t) => t.name === 'save_agent');
    expect(tool!.inputSchema.required).toContain('agent_url');
  });

  it('save_agent supports auth_token and protocol params', () => {
    const tool = AGENT_CONTEXT_TOOL_DEFINITIONS.find((t) => t.name === 'save_agent');
    expect(tool!.inputSchema.properties).toHaveProperty('auth_token');
    expect(tool!.inputSchema.properties).toHaveProperty('protocol');
  });

  it('remove_saved_agent requires agent_url', () => {
    const tool = AGENT_CONTEXT_TOOL_DEFINITIONS.find((t) => t.name === 'remove_saved_agent');
    expect(tool!.inputSchema.required).toContain('agent_url');
  });
});

describe('SCHEMA_TOOL_DEFINITIONS', () => {
  const EXPECTED = ['validate_json', 'get_schema'];

  it('exports exactly the 2 schema tools', () => {
    const names = SCHEMA_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED));
    expect(names).toHaveLength(EXPECTED.length);
  });

  it('validate_json requires json parameter', () => {
    const tool = SCHEMA_TOOL_DEFINITIONS.find((t) => t.name === 'validate_json');
    expect(tool!.inputSchema.required).toContain('json');
  });

  it('get_schema requires schema_path parameter', () => {
    const tool = SCHEMA_TOOL_DEFINITIONS.find((t) => t.name === 'get_schema');
    expect(tool!.inputSchema.required).toContain('schema_path');
  });
});

describe('PROPERTY_TOOL_DEFINITIONS', () => {
  it('exports validate_adagents', () => {
    expect(PROPERTY_TOOL_DEFINITIONS).toHaveLength(1);
    expect(PROPERTY_TOOL_DEFINITIONS[0].name).toBe('validate_adagents');
  });

  it('validate_adagents requires domain', () => {
    expect(PROPERTY_TOOL_DEFINITIONS[0].inputSchema.required).toContain('domain');
  });
});

describe('ALL_EXPOSED_TOOL_DEFINITIONS', () => {
  it('combines all tool groups (4 eval + 3 context + 2 schema + 1 property = 10)', () => {
    expect(ALL_EXPOSED_TOOL_DEFINITIONS).toHaveLength(10);
  });

  it('has no duplicate tool names', () => {
    const names = ALL_EXPOSED_TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has valid MCP format', () => {
    for (const tool of ALL_EXPOSED_TOOL_DEFINITIONS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    }
  });
});

describe('createMemberToolHandler', () => {
  it('returns a function with 2 params (args, authContext)', () => {
    const handler = createMemberToolHandler('get_agent_status');
    expect(typeof handler).toBe('function');
    expect(handler.length).toBe(2);
  });

  it('returns isError when called without auth', async () => {
    const handler = createMemberToolHandler('get_agent_status');
    const result = await handler({ agent_url: 'https://example.com' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Authentication required');
  });

  it('returns isError for anonymous auth context', async () => {
    const handler = createMemberToolHandler('save_agent');
    const result = await handler(
      { agent_url: 'https://example.com' },
      { sub: 'anonymous', isM2M: false, payload: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Authentication required');
  });

  it('save_agent rejects Basic credentials with a blank username before saving', async () => {
    vi.spyOn(hostnameVerification, 'verifyAgentHostname').mockResolvedValueOnce({
      ok: true,
      verified_domain: 'example.com',
      agent_hostname: 'agent.example.com',
    });
    const createSpy = vi.spyOn(AgentContextDatabase.prototype, 'create');
    const saveAuthSpy = vi.spyOn(AgentContextDatabase.prototype, 'saveAuthToken');

    const handler = createMemberToolHandler('save_agent');
    const result = await handler(
      {
        agent_url: 'https://agent.example.com/mcp',
        type: 'sales',
        auth_type: 'basic',
        auth_token: ':test-password',
      },
      {
        sub: 'user_123',
        orgId: 'org_123',
        email: 'user@example.com',
        isM2M: false,
        payload: {},
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/non-empty username/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(saveAuthSpy).not.toHaveBeenCalled();
  });

  it('save_agent accepts Basic credentials with a blank password and stores base64 form', async () => {
    vi.spyOn(hostnameVerification, 'verifyAgentHostname').mockResolvedValueOnce({
      ok: true,
      verified_domain: 'example.com',
      agent_hostname: 'agent.example.com',
    });
    vi.spyOn(AgentContextDatabase.prototype, 'getByOrgAndUrl').mockResolvedValueOnce(null);
    vi.spyOn(AgentContextDatabase.prototype, 'create').mockResolvedValueOnce(savedAgentContext());
    const saveAuthSpy = vi.spyOn(AgentContextDatabase.prototype, 'saveAuthToken').mockResolvedValueOnce();
    vi.spyOn(AgentContextDatabase.prototype, 'getById').mockResolvedValueOnce(
      savedAgentContext({
        has_auth_token: true,
        auth_token_hint: 'test-user:****',
        auth_type: 'basic',
      }),
    );
    vi.spyOn(MemberDatabase.prototype, 'getProfileByOrgId').mockResolvedValueOnce({
      id: 'profile_123',
      workos_organization_id: 'org_123',
      display_name: 'Example Org',
      slug: 'example-org',
      agents: [],
    } as any);
    vi.spyOn(MemberDatabase.prototype, 'updateProfile').mockResolvedValueOnce({} as any);
    vi.spyOn(clientDb, 'query').mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const handler = createMemberToolHandler('save_agent');
    const result = await handler(
      {
        agent_url: 'https://agent.example.com/mcp',
        type: 'sales',
        auth_type: 'basic',
        auth_token: 'test-user:',
      },
      {
        sub: 'user_123',
        orgId: 'org_123',
        email: 'user@example.com',
        isM2M: false,
        payload: {},
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Basic auth token saved securely');
    expect(saveAuthSpy).toHaveBeenCalledWith(
      'ctx_123',
      Buffer.from('test-user:', 'utf8').toString('base64'),
      'basic',
    );
  });
});

describe('createStatelessToolHandlers', () => {
  it('returns handlers for schema and property tools', () => {
    const handlers = createStatelessToolHandlers();
    expect(handlers.has('validate_json')).toBe(true);
    expect(handlers.has('get_schema')).toBe(true);
    expect(handlers.has('validate_adagents')).toBe(true);
  });

  it('handlers are functions', () => {
    const handlers = createStatelessToolHandlers();
    for (const [, handler] of handlers) {
      expect(typeof handler).toBe('function');
    }
  });
});
