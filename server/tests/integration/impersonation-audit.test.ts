import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

/**
 * Impersonation Audit Logging Tests
 *
 * Tests for the audit logging functionality when admins impersonate users
 * via WorkOS impersonation sessions.
 */

// Track whether impersonation is active for each request
let impersonatorData: { email: string; reason: string | null } | null = null;

// Mock auth middleware to simulate impersonation
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: 'user_impersonated',
      email: 'impersonated@example.com',
      firstName: 'Impersonated',
      lastName: 'User',
      is_admin: false,
      // Include impersonator when set
      impersonator: impersonatorData,
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => next(),
  optionalAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: 'user_impersonated',
      email: 'impersonated@example.com',
      firstName: 'Impersonated',
      lastName: 'User',
      impersonator: impersonatorData,
    };
    next();
  },
}));

// Mock the Claude client to avoid actual API calls
vi.mock('../../src/addie/claude-client.js', () => ({
  AddieClaudeClient: vi.fn().mockImplementation(() => ({
    processMessage: vi.fn().mockResolvedValue({
      text: 'Test response from Addie',
      tools_used: [],
      tool_executions: [],
      flagged: false,
      timing: { total_ms: 100 },
    }),
    registerTool: vi.fn(),
  })),
}));

// Mock knowledge search
vi.mock('../../src/addie/mcp/knowledge-search.js', () => ({
  initializeKnowledgeSearch: vi.fn().mockResolvedValue(undefined),
  isKnowledgeReady: vi.fn().mockReturnValue(true),
  KNOWLEDGE_TOOLS: [],
  createKnowledgeToolHandlers: vi.fn().mockReturnValue(new Map()),
}));

// Mock member context
vi.mock('../../src/addie/member-context.js', () => ({
  getWebMemberContext: vi.fn().mockResolvedValue({
    is_mapped: true,
    is_member: true,
    slack_linked: false,
    workos_user: {
      workos_user_id: 'user_impersonated',
      email: 'impersonated@example.com',
      first_name: 'Impersonated',
    },
  }),
  formatMemberContextForPrompt: vi.fn().mockReturnValue('## User Context\nTest context'),
  getMemberContext: vi.fn().mockResolvedValue({
    is_mapped: false,
    is_member: false,
    slack_linked: false,
  }),
}));

describe('Impersonation Audit Logging Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    // Set required environment variable for Addie
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Initialize HTTP server
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM addie_messages WHERE conversation_id IN (SELECT conversation_id FROM addie_conversations WHERE user_id = 'user_impersonated')");
    await pool.query("DELETE FROM addie_conversations WHERE user_id = 'user_impersonated'");

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Reset impersonation state before each test
    impersonatorData = null;

    // Clean up any existing test conversations
    await pool.query("DELETE FROM addie_messages WHERE conversation_id IN (SELECT conversation_id FROM addie_conversations WHERE user_id = 'user_impersonated')");
    await pool.query("DELETE FROM addie_conversations WHERE user_id = 'user_impersonated'");
  });

  describe('Conversation creation with impersonation', () => {
    it('should record impersonator info when creating conversation during impersonation', async () => {
      // Set impersonation state
      impersonatorData = {
        email: 'admin@example.com',
        reason: 'Debugging user issue #123',
      };

      // Create a new conversation via chat API
      const response = await request(app)
        .post('/api/addie/chat')
        .send({
          message: 'Hello, testing impersonation',
        })
        .expect(200);

      expect(response.body).toHaveProperty('conversation_id');
      const conversationId = response.body.conversation_id;

      // Verify impersonation info is stored in database
      const result = await pool.query(
        `SELECT impersonator_email, impersonation_reason FROM addie_conversations WHERE conversation_id = $1`,
        [conversationId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].impersonator_email).toBe('admin@example.com');
      expect(result.rows[0].impersonation_reason).toBe('Debugging user issue #123');
    });

    it('should not record impersonator info for normal sessions', async () => {
      // No impersonation
      impersonatorData = null;

      // Create a new conversation
      const response = await request(app)
        .post('/api/addie/chat')
        .send({
          message: 'Hello, normal session',
        })
        .expect(200);

      const conversationId = response.body.conversation_id;

      // Verify no impersonation info is stored
      const result = await pool.query(
        `SELECT impersonator_email, impersonation_reason FROM addie_conversations WHERE conversation_id = $1`,
        [conversationId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].impersonator_email).toBeNull();
      expect(result.rows[0].impersonation_reason).toBeNull();
    });
  });

  describe('Message recording with impersonation', () => {
    it('should record impersonator email on messages during impersonation', async () => {
      // Set impersonation state
      impersonatorData = {
        email: 'admin@example.com',
        reason: 'Testing Addie responses',
      };

      // Send a message
      const response = await request(app)
        .post('/api/addie/chat')
        .send({
          message: 'What can you help me with?',
        })
        .expect(200);

      const conversationId = response.body.conversation_id;

      // Verify messages have impersonator email
      const result = await pool.query(
        `SELECT role, impersonator_email FROM addie_messages WHERE conversation_id = $1 ORDER BY created_at`,
        [conversationId]
      );

      // Should have user message and assistant response
      expect(result.rows.length).toBe(2);

      // User message should have impersonator email
      const userMessage = result.rows.find((r: any) => r.role === 'user');
      expect(userMessage.impersonator_email).toBe('admin@example.com');

      // Assistant message should also have impersonator email (audit trail)
      const assistantMessage = result.rows.find((r: any) => r.role === 'assistant');
      expect(assistantMessage.impersonator_email).toBe('admin@example.com');
    });

    it('should not record impersonator email on messages for normal sessions', async () => {
      // No impersonation
      impersonatorData = null;

      // Send a message
      const response = await request(app)
        .post('/api/addie/chat')
        .send({
          message: 'Normal message without impersonation',
        })
        .expect(200);

      const conversationId = response.body.conversation_id;

      // Verify messages have no impersonator email
      const result = await pool.query(
        `SELECT role, impersonator_email FROM addie_messages WHERE conversation_id = $1`,
        [conversationId]
      );

      expect(result.rows.length).toBe(2);
      result.rows.forEach((row: any) => {
        expect(row.impersonator_email).toBeNull();
      });
    });
  });

  describe('Impersonation with null reason', () => {
    it('should handle impersonation without a reason', async () => {
      // Set impersonation with null reason
      impersonatorData = {
        email: 'admin@example.com',
        reason: null,
      };

      // Create a conversation
      const response = await request(app)
        .post('/api/addie/chat')
        .send({
          message: 'Testing without reason',
        })
        .expect(200);

      const conversationId = response.body.conversation_id;

      // Verify impersonator email is stored but reason is null
      const result = await pool.query(
        `SELECT impersonator_email, impersonation_reason FROM addie_conversations WHERE conversation_id = $1`,
        [conversationId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].impersonator_email).toBe('admin@example.com');
      expect(result.rows[0].impersonation_reason).toBeNull();
    });
  });

  describe('Querying impersonated conversations', () => {
    it('should be able to find all impersonated conversations', async () => {
      // Create an impersonated conversation
      impersonatorData = {
        email: 'admin1@example.com',
        reason: 'Support ticket #1',
      };

      await request(app)
        .post('/api/addie/chat')
        .send({ message: 'First impersonated message' })
        .expect(200);

      // Create another impersonated conversation
      impersonatorData = {
        email: 'admin2@example.com',
        reason: 'Support ticket #2',
      };

      await request(app)
        .post('/api/addie/chat')
        .send({ message: 'Second impersonated message' })
        .expect(200);

      // Create a normal conversation
      impersonatorData = null;
      await request(app)
        .post('/api/addie/chat')
        .send({ message: 'Normal message' })
        .expect(200);

      // Query for impersonated conversations
      const result = await pool.query(
        `SELECT conversation_id, impersonator_email, impersonation_reason
         FROM addie_conversations
         WHERE user_id = 'user_impersonated' AND impersonator_email IS NOT NULL`
      );

      // Should find 2 impersonated conversations
      expect(result.rows.length).toBe(2);
      expect(result.rows.some((r: any) => r.impersonator_email === 'admin1@example.com')).toBe(true);
      expect(result.rows.some((r: any) => r.impersonator_email === 'admin2@example.com')).toBe(true);
    });
  });
});

describe('Impersonation Database Schema', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('should have impersonation columns on addie_conversations', async () => {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'addie_conversations'
        AND column_name IN ('impersonator_email', 'impersonation_reason')
    `);

    const columns = result.rows.map((r: any) => r.column_name);
    expect(columns).toContain('impersonator_email');
    expect(columns).toContain('impersonation_reason');
  });

  it('should have impersonation column on addie_messages', async () => {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'addie_messages'
        AND column_name = 'impersonator_email'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].column_name).toBe('impersonator_email');
  });

  it('should have index on impersonator_email for efficient querying', async () => {
    const result = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'addie_conversations'
        AND indexname LIKE '%impersonator%'
    `);

    expect(result.rows.length).toBeGreaterThan(0);
  });
});
