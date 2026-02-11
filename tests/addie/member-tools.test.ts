/**
 * Tests for Addie member tools
 *
 * Tests the tool definitions and handler logic that can be tested
 * without external dependencies (API calls, database, etc.)
 */

import { describe, it, expect } from '@jest/globals';

// Import the tool definitions directly (no side effects)
import { MEMBER_TOOLS, createMemberToolHandlers } from '../../server/src/addie/mcp/member-tools.js';

describe('MEMBER_TOOLS definitions', () => {
  it('exports an array of tools', () => {
    expect(Array.isArray(MEMBER_TOOLS)).toBe(true);
    expect(MEMBER_TOOLS.length).toBeGreaterThan(0);
  });

  it('all tools have required properties', () => {
    for (const tool of MEMBER_TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('input_schema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toHaveProperty('type', 'object');
      expect(tool.input_schema).toHaveProperty('properties');
      expect(tool.input_schema).toHaveProperty('required');
    }
  });

  it('does not have validate_adagents tool (moved to property-tools)', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'validate_adagents');
    expect(tool).toBeUndefined();
  });

  it('has list_working_groups tool with limit parameter', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'list_working_groups');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('limit');
    expect(tool?.description).toContain('working groups');
  });

  it('has get_working_group tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_working_group');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('slug');
    expect(tool?.input_schema.required).toContain('slug');
  });

  it('has join_working_group tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'join_working_group');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('slug');
    expect(tool?.input_schema.required).toContain('slug');
    expect(tool?.description).toContain('user must be a member');
  });

  it('has get_my_working_groups tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_my_working_groups');
    expect(tool).toBeDefined();
  });

  it('has get_my_profile tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_my_profile');
    expect(tool).toBeDefined();
  });

  it('has update_my_profile tool with optional fields', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'update_my_profile');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('headline');
    expect(tool?.input_schema.properties).toHaveProperty('bio');
    expect(tool?.input_schema.properties).toHaveProperty('focus_areas');
    expect(tool?.input_schema.properties).toHaveProperty('website');
    expect(tool?.input_schema.properties).toHaveProperty('linkedin');
    expect(tool?.input_schema.properties).toHaveProperty('location');
    // All fields are optional
    expect(tool?.input_schema.required).toEqual([]);
  });

  it('has list_perspectives tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'list_perspectives');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('limit');
  });

  it('has create_working_group_post tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'create_working_group_post');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.required).toContain('working_group_slug');
    expect(tool?.input_schema.required).toContain('title');
    expect(tool?.input_schema.required).toContain('content');
    expect(tool?.input_schema.properties).toHaveProperty('post_type');
    expect(tool?.input_schema.properties).toHaveProperty('link_url');
  });

  it('has get_account_link tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_account_link');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('Slack account');
  });

  it('has probe_adcp_agent tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'probe_adcp_agent');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('agent_url');
    expect(tool?.input_schema.required).toContain('agent_url');
    expect(tool?.description).toContain('online');
    expect(tool?.description).toContain('capabilities');
  });

  it('has check_publisher_authorization tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'check_publisher_authorization');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('domain');
    expect(tool?.input_schema.properties).toHaveProperty('agent_url');
    expect(tool?.input_schema.required).toContain('domain');
    expect(tool?.input_schema.required).toContain('agent_url');
  });

  it('has draft_github_issue tool', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'draft_github_issue');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('title');
    expect(tool?.input_schema.properties).toHaveProperty('body');
    expect(tool?.input_schema.properties).toHaveProperty('repo');
    expect(tool?.input_schema.properties).toHaveProperty('labels');
    expect(tool?.input_schema.required).toContain('title');
    expect(tool?.input_schema.required).toContain('body');
  });
});

describe('createMemberToolHandlers', () => {
  it('returns a Map of handlers', () => {
    const handlers = createMemberToolHandlers(null);
    expect(handlers).toBeInstanceOf(Map);
    expect(handlers.size).toBeGreaterThan(0);
  });

  it('has a handler for each tool', () => {
    const handlers = createMemberToolHandlers(null);
    for (const tool of MEMBER_TOOLS) {
      expect(handlers.has(tool.name)).toBe(true);
      expect(typeof handlers.get(tool.name)).toBe('function');
    }
  });

  describe('get_account_link handler', () => {
    it('returns already linked message when user has workos_user_id', async () => {
      const handlers = createMemberToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'test@example.com',
        },
      });

      const handler = handlers.get('get_account_link')!;
      const result = await handler({});

      expect(result).toContain('already linked');
      expect(result).toContain('full access');
    });

    it('returns sign-in link for anonymous/unmapped users', async () => {
      const handlers = createMemberToolHandlers({
        is_mapped: false,
        is_member: false,
      });

      const handler = handlers.get('get_account_link')!;
      const result = await handler({});

      expect(result).toContain('Sign In or Create an Account');
      expect(result).toContain('https://agenticadvertising.org/auth/login');
      expect(result).toContain('member features');
    });

    it('returns sign-in link when user has slack_user_id but no workos_user_id', async () => {
      const handlers = createMemberToolHandlers({
        is_mapped: true,
        is_member: false,
        slack_user: {
          slack_user_id: 'U12345',
          display_name: 'testuser',
          email: null,
        },
      });

      const handler = handlers.get('get_account_link')!;
      const result = await handler({});

      expect(result).toContain('Link Your Account');
      expect(result).toContain('agenticadvertising.org/auth/login');
      expect(result).toContain('slack_user_id=U12345');
    });
  });

  describe('draft_github_issue handler', () => {
    it('generates valid GitHub issue URL', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      const result = await handler({
        title: 'Test Issue',
        body: 'This is a test issue body',
        repo: 'adcp',
        labels: ['bug'],
      });

      expect(result).toContain('GitHub Issue Draft');
      expect(result).toContain('github.com/adcontextprotocol/adcp/issues/new');
      expect(result).toContain('Test Issue');
      expect(result).toContain('This is a test issue body');
      expect(result).toContain('bug');
    });

    it('uses default repo when not specified', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      const result = await handler({
        title: 'Test Issue',
        body: 'Body text',
      });

      expect(result).toContain('adcontextprotocol/adcp');
    });

    it('warns when URL is very long', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      // Create a body that will exceed warning threshold (6000 chars)
      const longBody = 'x'.repeat(6000);

      const result = await handler({
        title: 'Test Issue',
        body: longBody,
      });

      expect(result).toContain('quite long');
    });

    it('provides manual instructions when URL exceeds max length', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      // Create a body that will exceed max (8000 chars)
      const veryLongBody = 'x'.repeat(8000);

      const result = await handler({
        title: 'Test Issue',
        body: veryLongBody,
      });

      expect(result).toContain('too long for a pre-filled URL');
      expect(result).toContain('create the issue manually');
    });
  });

  describe('user-scoped tools require authentication', () => {
    const userScopedTools = [
      'join_working_group',
      'get_my_working_groups',
      'get_my_profile',
      'update_my_profile',
      'create_working_group_post',
    ];

    it.each(userScopedTools)('%s returns auth error when not logged in', async (toolName) => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get(toolName)!;

      const result = await handler({ slug: 'test', title: 'test', content: 'test', working_group_slug: 'test' });

      expect(result).toContain('need to be logged in');
      expect(result).toContain('agenticadvertising.org');
    });
  });
});
