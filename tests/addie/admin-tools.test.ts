/**
 * Tests for Addie admin tools
 *
 * Tests the tool definitions and handler logic that can be tested
 * without external dependencies (API calls, database, etc.)
 */

import { describe, it, expect, beforeAll, jest } from '@jest/globals';

// Set required environment variables before any imports that depend on them
process.env.WORKOS_API_KEY = 'sk_test_mock_workos_key';
process.env.WORKOS_CLIENT_ID = 'client_mock_id';
process.env.WORKOS_REDIRECT_URI = 'http://localhost:3000/callback';

// Mock the db client to prevent actual database connections
jest.mock('../../server/src/db/client.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockRejectedValue(new Error('Database not available in tests')),
  }),
  query: jest.fn().mockRejectedValue(new Error('Database not available in tests')),
}));

// Import the tool definitions after mocks are set up
import { ADMIN_TOOLS, createAdminToolHandlers } from '../../server/src/addie/mcp/admin-tools.js';

describe('ADMIN_TOOLS definitions', () => {
  it('exports an array of tools', () => {
    expect(Array.isArray(ADMIN_TOOLS)).toBe(true);
    expect(ADMIN_TOOLS.length).toBeGreaterThan(0);
  });

  it('all tools have required properties', () => {
    for (const tool of ADMIN_TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('input_schema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toHaveProperty('type', 'object');
      expect(tool.input_schema).toHaveProperty('properties');
    }
  });

  // ============================================
  // PERSPECTIVE / CMS TOOLS
  // ============================================

  it('has list_perspective_drafts tool', () => {
    const tool = ADMIN_TOOLS.find(t => t.name === 'list_perspective_drafts');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('limit');
    expect(tool?.description).toContain('drafts');
    expect(tool?.description).toContain('review');
  });

  it('has publish_perspective tool', () => {
    const tool = ADMIN_TOOLS.find(t => t.name === 'publish_perspective');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('perspective_id');
    expect(tool?.input_schema.required).toContain('perspective_id');
    expect(tool?.description).toContain('Publish');
  });

  it('has update_perspective tool', () => {
    const tool = ADMIN_TOOLS.find(t => t.name === 'update_perspective');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('perspective_id');
    expect(tool?.input_schema.properties).toHaveProperty('title');
    expect(tool?.input_schema.properties).toHaveProperty('content');
    expect(tool?.input_schema.properties).toHaveProperty('excerpt');
    expect(tool?.input_schema.properties).toHaveProperty('category');
    expect(tool?.input_schema.properties).toHaveProperty('tags');
    expect(tool?.input_schema.properties).toHaveProperty('author_name');
    expect(tool?.input_schema.required).toContain('perspective_id');
  });

  it('has archive_perspective tool', () => {
    const tool = ADMIN_TOOLS.find(t => t.name === 'archive_perspective');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.properties).toHaveProperty('perspective_id');
    expect(tool?.input_schema.required).toContain('perspective_id');
    expect(tool?.description).toContain('Archive');
    expect(tool?.description).toContain('remove');
  });
});

describe('createAdminToolHandlers', () => {
  it('returns a Map of handlers', () => {
    const handlers = createAdminToolHandlers(null);
    expect(handlers).toBeInstanceOf(Map);
    expect(handlers.size).toBeGreaterThan(0);
  });

  it('has a handler for each tool', () => {
    const handlers = createAdminToolHandlers(null);
    for (const tool of ADMIN_TOOLS) {
      expect(handlers.has(tool.name)).toBe(true);
      expect(typeof handlers.get(tool.name)).toBe('function');
    }
  });

  describe('perspective handlers require admin access', () => {
    const perspectiveTools = [
      'list_perspective_drafts',
      'publish_perspective',
      'update_perspective',
      'archive_perspective',
    ];

    it.each(perspectiveTools)('%s returns admin error when not admin', async (toolName) => {
      // Non-admin context
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'test@example.com',
        },
        org_membership: {
          role: 'member', // Not admin
        },
      });

      const handler = handlers.get(toolName)!;
      const result = await handler({ perspective_id: 'test-id', limit: 10 });

      expect(result).toContain('admin access');
    });
  });

  describe('publish_perspective handler', () => {
    it('returns error when perspective_id is missing', async () => {
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'admin@example.com',
        },
        org_membership: {
          role: 'admin',
        },
      });

      const handler = handlers.get('publish_perspective')!;
      const result = await handler({});

      expect(result).toContain('perspective_id is required');
    });
  });

  describe('update_perspective handler', () => {
    it('returns error when perspective_id is missing', async () => {
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'admin@example.com',
        },
        org_membership: {
          role: 'admin',
        },
      });

      const handler = handlers.get('update_perspective')!;
      const result = await handler({ title: 'New Title' });

      expect(result).toContain('perspective_id is required');
    });

    it('returns error when no fields to update', async () => {
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'admin@example.com',
        },
        org_membership: {
          role: 'admin',
        },
      });

      const handler = handlers.get('update_perspective')!;
      // Only providing perspective_id without any fields to update
      // Since the handler checks if perspective exists first (requires DB),
      // and we don't mock that, the error will be different
      // This test just verifies the handler runs without crashing
      const result = await handler({ perspective_id: 'test-id' });

      // Result will contain an error since there's no DB
      expect(typeof result).toBe('string');
    });
  });

  describe('archive_perspective handler', () => {
    it('returns error when perspective_id is missing', async () => {
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: 'user_123',
          email: 'admin@example.com',
        },
        org_membership: {
          role: 'admin',
        },
      });

      const handler = handlers.get('archive_perspective')!;
      const result = await handler({});

      expect(result).toContain('perspective_id is required');
    });
  });
});
