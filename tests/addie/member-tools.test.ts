/**
 * Tests for Addie member tools
 *
 * Tests the tool definitions and handler logic that can be tested
 * without external dependencies (API calls, database, etc.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../server/src/addie/member-context.js';

vi.mock('../../server/src/services/pipes.js', () => ({
  getGitHubAccessToken: vi.fn(),
}));

// Import the tool definitions directly (no side effects)
import { MEMBER_TOOLS, createMemberToolHandlers, extractAdcpVersion } from '../../server/src/addie/mcp/member-tools.js';
import { getGitHubAccessToken } from '../../server/src/services/pipes.js';

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

  it('has get_my_profile tool for personal profile', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_my_profile');
    expect(tool).toBeDefined();
  });

  it('has update_my_profile tool with community profile fields', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'update_my_profile');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('headline');
    expect(tool?.input_schema.properties).toHaveProperty('bio');
    expect(tool?.input_schema.properties).toHaveProperty('expertise');
    expect(tool?.input_schema.properties).toHaveProperty('city');
    expect(tool?.input_schema.required).toEqual([]);
  });

  it('has get_company_listing tool for org directory entry', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'get_company_listing');
    expect(tool).toBeDefined();
  });

  it('has update_company_listing tool with member profile fields', () => {
    const tool = MEMBER_TOOLS.find(t => t.name === 'update_company_listing');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('tagline');
    expect(tool?.input_schema.properties).toHaveProperty('description');
    expect(tool?.input_schema.properties).toHaveProperty('offerings');
    expect(tool?.input_schema.properties).toHaveProperty('contact_website');
    expect(tool?.input_schema.properties).toHaveProperty('headquarters');
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
        slack_linked: false,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'test@example.com',
        },
      } as MemberContext);

      const handler = handlers.get('get_account_link')!;
      const result = await handler({});

      expect(result).toContain('already linked');
      expect(result).toContain('full access');
    });

    it('returns sign-in link for anonymous/unmapped users', async () => {
      const handlers = createMemberToolHandlers({
        is_mapped: false,
        is_member: false,
        slack_linked: false,
      } as MemberContext);

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
        slack_linked: true,
        slack_user: {
          slack_user_id: 'U12345',
          display_name: 'testuser',
          email: null,
        },
      } as MemberContext);

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

    it('accepts adcp-client as a valid repo', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      const result = await handler({
        title: 'T',
        body: 'B',
        repo: 'adcp-client',
      });

      expect(result).toContain('github.com/adcontextprotocol/adcp-client/issues/new');
    });

    it('routes invented repo names to adcp with a subproject note in the body', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('draft_github_issue')!;

      const result = await handler({
        title: 'T',
        body: 'Original body',
        repo: 'creative-agent',
      });

      expect(result).toContain('github.com/adcontextprotocol/adcp/issues/new');
      expect(result).not.toContain('github.com/adcontextprotocol/creative-agent');
      expect(result).toContain('Subproject');
      expect(result).toContain('creative-agent');
      expect(result).toContain('Original body');
    });
  });

  describe('create_github_issue handler', () => {
    const loggedInContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_abc',
        email: 'jane@example.com',
        first_name: 'Jane',
        last_name: 'Doe',
      },
      organization: { name: 'Acme Corp' },
    } as unknown as MemberContext;

    let fetchMock: ReturnType<typeof vi.fn>;
    const getTokenMock = vi.mocked(getGitHubAccessToken);

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      getTokenMock.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('requires a logged-in user', async () => {
      const handlers = createMemberToolHandlers(null);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('logged in');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getTokenMock).not.toHaveBeenCalled();
    });

    it("leads with the Connect offer when user hasn't connected GitHub", async () => {
      getTokenMock.mockResolvedValue({ status: 'not_connected' });

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(getTokenMock).toHaveBeenCalledWith('user_abc');
      // Should surface our session-aware bouncer URL, not a raw WorkOS Pipes URL,
      // so a Slack click that arrives without an active AuthKit session bounces
      // through login first and mints a fresh Pipes URL on the click.
      expect(result).toMatch(/\[Connect GitHub\]\([^)]*\/connect\/github\?return_to=/);
      expect(result).toContain('draft_github_issue');
      // Lead line should be the offer, not the failure reason.
      const firstLine = result.split('\n')[0];
      expect(firstLine).toContain('Connect GitHub');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns Reconnect URL when connection needs reauthorization', async () => {
      getTokenMock.mockResolvedValue({ status: 'needs_reauthorization', missingScopes: ['public_repo'] });

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('re-authorization');
      expect(result).toMatch(/\[Reconnect GitHub\]\([^)]*\/connect\/github\?return_to=/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('gracefully degrades when Pipes getAccessToken throws', async () => {
      getTokenMock.mockRejectedValue(new Error('workos api down'));

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('unavailable');
      expect(result).toContain('draft_github_issue');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates an issue via the GitHub API using the Pipes user token', async () => {
      getTokenMock.mockResolvedValue({ status: 'ok', accessToken: 'gho_pipes_token', scopes: ['public_repo'], missingScopes: [] });
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ html_url: 'https://github.com/adcontextprotocol/adcp/issues/4242', number: 4242 }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'Bug report', body: 'Something broke.' });

      expect(result).toContain('#4242');
      expect(result).toContain('https://github.com/adcontextprotocol/adcp/issues/4242');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/adcontextprotocol/adcp/issues');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer gho_pipes_token');
      const payload = JSON.parse(init.body as string) as { title: string; body: string; labels: string[] };
      expect(payload.title).toBe('Bug report');
      expect(payload.body).toBe('Something broke.');
      expect(payload.body).not.toContain('Filed by Addie');
      expect(payload.labels).toEqual(['community-reported']);
    });

    it('rejects unknown repos and defaults to adcp', async () => {
      getTokenMock.mockResolvedValue({ status: 'ok', accessToken: 'gho_pipes_token', scopes: [], missingScopes: [] });
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ html_url: 'https://github.com/adcontextprotocol/adcp/issues/1', number: 1 }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      await handler({ title: 'T', body: 'B', repo: 'adcp-client' });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/adcontextprotocol/adcp/issues');
    });

    it('retries without labels when GitHub rejects an unknown label', async () => {
      getTokenMock.mockResolvedValue({ status: 'ok', accessToken: 'gho_pipes_token', scopes: [], missingScopes: [] });
      fetchMock
        .mockResolvedValueOnce(
          new Response('validation failed: label does not exist', { status: 422 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ html_url: 'https://github.com/adcontextprotocol/adcp/issues/77', number: 77 }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
        );

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('#77');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      expect(retryBody).not.toHaveProperty('labels');
    });

    it('returns a fallback message on non-ok responses', async () => {
      getTokenMock.mockResolvedValue({ status: 'ok', accessToken: 'gho_pipes_token', scopes: [], missingScopes: [] });
      fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('500');
      expect(result).toContain('draft_github_issue');
    });

    it('returns a network-error message when fetch throws', async () => {
      getTokenMock.mockResolvedValue({ status: 'ok', accessToken: 'gho_pipes_token', scopes: [], missingScopes: [] });
      fetchMock.mockRejectedValue(new Error('connection refused'));

      const handlers = createMemberToolHandlers(loggedInContext);
      const handler = handlers.get('create_github_issue')!;

      const result = await handler({ title: 'T', body: 'B' });

      expect(result).toContain('network error');
      expect(result).toContain('draft_github_issue');
    });
  });

  describe('extractAdcpVersion', () => {
    it('extracts version from valid AdCP extension', () => {
      const extensions = [{
        uri: 'https://adcontextprotocol.org/extensions/adcp',
        params: { adcp_version: '2.6.0' },
      }];
      expect(extractAdcpVersion(extensions)).toBe('2.6.0');
    });

    it('extracts v3 version', () => {
      const extensions = [{
        uri: 'https://adcontextprotocol.org/extensions/adcp',
        params: { adcp_version: '3.0.0' },
      }];
      expect(extractAdcpVersion(extensions)).toBe('3.0.0');
    });

    it('returns undefined for non-array input', () => {
      expect(extractAdcpVersion(undefined)).toBeUndefined();
      expect(extractAdcpVersion(null)).toBeUndefined();
      expect(extractAdcpVersion('not an array')).toBeUndefined();
      expect(extractAdcpVersion({})).toBeUndefined();
    });

    it('returns undefined when no AdCP extension exists', () => {
      const extensions = [{
        uri: 'https://example.com/other',
        params: { adcp_version: '2.0.0' },
      }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('rejects extensions with non-adcontextprotocol.org hostname', () => {
      const extensions = [{
        uri: 'https://evil.com/adcontextprotocol.org/spoof',
        params: { adcp_version: '2.0.0' },
      }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('returns undefined for malformed version strings', () => {
      const extensions = [{
        uri: 'https://adcontextprotocol.org/extensions/adcp',
        params: { adcp_version: 'evil' },
      }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('returns undefined for empty version string', () => {
      const extensions = [{
        uri: 'https://adcontextprotocol.org/extensions/adcp',
        params: { adcp_version: '' },
      }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('returns undefined for invalid URI', () => {
      const extensions = [{
        uri: 'not-a-url',
        params: { adcp_version: '2.6.0' },
      }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('returns undefined when extensions have no uri', () => {
      const extensions = [{ params: { adcp_version: '2.6.0' } }];
      expect(extractAdcpVersion(extensions)).toBeUndefined();
    });

    it('handles empty extensions array', () => {
      expect(extractAdcpVersion([])).toBeUndefined();
    });
  });

  describe('user-scoped tools require authentication', () => {
    const userScopedTools = [
      'join_working_group',
      'get_my_working_groups',
      'get_my_profile',
      'update_my_profile',
      'get_company_listing',
      'update_company_listing',
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
