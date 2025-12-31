import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: 'user_test_threads',
      email: 'test@example.com',
      is_admin: true,
      firstName: 'Test',
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => next(),
  optionalAuth: (req: any, res: any, next: any) => {
    req.user = {
      id: 'user_test_threads',
      email: 'test@example.com',
      firstName: 'Test',
    };
    next();
  },
}));

// Mock Stripe client
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

describe('Threads API Integration Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  let testThreadId: string;
  let testMessageId: string;

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Initialize HTTP server
    server = new HTTPServer();
    await server.start(0); // Use port 0 for random port
    app = server.app;

    // Create a test thread and messages
    const threadResult = await pool.query(`
      INSERT INTO addie_threads (channel, external_id, user_type, user_id, user_display_name, context)
      VALUES ('slack', 'test-api-thread:123', 'slack', 'U_test', 'Test User', '{"team_id": "T123"}')
      RETURNING thread_id
    `);
    testThreadId = threadResult.rows[0].thread_id;

    // Add messages to the thread
    const msgResult = await pool.query(`
      INSERT INTO addie_thread_messages (thread_id, role, content, sequence_number)
      VALUES
        ($1, 'user', 'Hello!', 1),
        ($1, 'assistant', 'Hi! How can I help?', 2)
      RETURNING message_id
    `, [testThreadId]);
    testMessageId = msgResult.rows[1].message_id; // Get the assistant message ID
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query(`DELETE FROM addie_threads WHERE external_id LIKE 'test-api-%'`);
    await server?.stop();
    await closeDatabase();
  });

  // =========================================================================
  // Admin Threads API Tests
  // =========================================================================

  describe('GET /api/admin/addie/threads', () => {
    it('should list all threads', async () => {
      const response = await request(app)
        .get('/api/admin/addie/threads')
        .expect(200);

      expect(response.body).toHaveProperty('threads');
      expect(response.body.threads).toBeInstanceOf(Array);
      expect(response.body).toHaveProperty('total');
    });

    it('should filter by channel', async () => {
      const response = await request(app)
        .get('/api/admin/addie/threads?channel=slack')
        .expect(200);

      expect(response.body.threads.every((t: any) => t.channel === 'slack')).toBe(true);
    });

    it('should filter flagged threads', async () => {
      // First flag our test thread
      await pool.query('UPDATE addie_threads SET flagged = true WHERE thread_id = $1', [testThreadId]);

      const response = await request(app)
        .get('/api/admin/addie/threads?flagged_only=true')
        .expect(200);

      expect(response.body.threads.every((t: any) => t.flagged)).toBe(true);

      // Unflag for other tests
      await pool.query('UPDATE addie_threads SET flagged = false WHERE thread_id = $1', [testThreadId]);
    });

    it('should respect limit and offset', async () => {
      const response = await request(app)
        .get('/api/admin/addie/threads?limit=5&offset=0')
        .expect(200);

      expect(response.body.threads.length).toBeLessThanOrEqual(5);
    });
  });

  describe('GET /api/admin/addie/threads/stats', () => {
    it('should return thread statistics', async () => {
      const response = await request(app)
        .get('/api/admin/addie/threads/stats')
        .expect(200);

      expect(response.body).toHaveProperty('total_threads');
      expect(response.body).toHaveProperty('total_messages');
      expect(response.body).toHaveProperty('unique_users');
      expect(response.body).toHaveProperty('threads_last_24h');
      expect(response.body).toHaveProperty('flagged_threads');
      expect(response.body).toHaveProperty('unreviewed_threads');
      expect(response.body).toHaveProperty('by_channel');
      expect(response.body.by_channel).toBeInstanceOf(Array);
    });
  });

  describe('GET /api/admin/addie/threads/:id', () => {
    it('should return thread with messages', async () => {
      const response = await request(app)
        .get(`/api/admin/addie/threads/${testThreadId}`)
        .expect(200);

      expect(response.body.thread_id).toBe(testThreadId);
      expect(response.body.channel).toBe('slack');
      expect(response.body.messages).toBeInstanceOf(Array);
      expect(response.body.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('should return 404 for non-existent thread', async () => {
      const response = await request(app)
        .get('/api/admin/addie/threads/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect(response.body.error).toBe('Thread not found');
    });
  });

  describe('PUT /api/admin/addie/threads/:id/review', () => {
    it('should mark thread as reviewed', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/${testThreadId}/review`)
        .send({ notes: 'Reviewed in test' })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT reviewed, reviewed_by, review_notes FROM addie_threads WHERE thread_id = $1',
        [testThreadId]
      );
      expect(result.rows[0].reviewed).toBe(true);
      expect(result.rows[0].reviewed_by).toBe('user_test_threads');
      expect(result.rows[0].review_notes).toBe('Reviewed in test');

      // Reset for other tests
      await pool.query('UPDATE addie_threads SET reviewed = false WHERE thread_id = $1', [testThreadId]);
    });
  });

  describe('PUT /api/admin/addie/threads/:id/flag', () => {
    it('should flag a thread', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/${testThreadId}/flag`)
        .send({ reason: 'Test flagging' })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT flagged, flag_reason FROM addie_threads WHERE thread_id = $1',
        [testThreadId]
      );
      expect(result.rows[0].flagged).toBe(true);
      expect(result.rows[0].flag_reason).toBe('Test flagging');
    });

    it('should require reason to flag', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/${testThreadId}/flag`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Flag reason is required');
    });
  });

  describe('PUT /api/admin/addie/threads/:id/unflag', () => {
    it('should unflag a thread', async () => {
      // First ensure it's flagged
      await pool.query(
        'UPDATE addie_threads SET flagged = true, flag_reason = $2 WHERE thread_id = $1',
        [testThreadId, 'Pre-test flag']
      );

      const response = await request(app)
        .put(`/api/admin/addie/threads/${testThreadId}/unflag`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT flagged, flag_reason FROM addie_threads WHERE thread_id = $1',
        [testThreadId]
      );
      expect(result.rows[0].flagged).toBe(false);
      expect(result.rows[0].flag_reason).toBeNull();
    });
  });

  describe('PUT /api/admin/addie/threads/messages/:messageId/feedback', () => {
    it('should add feedback to a message', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/feedback`)
        .send({
          rating: 4,
          rating_category: 'accuracy',
          rating_notes: 'Pretty good response',
          feedback_tags: ['clear', 'helpful'],
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT rating, rating_category, rating_notes, rated_by FROM addie_thread_messages WHERE message_id = $1',
        [testMessageId]
      );
      expect(result.rows[0].rating).toBe(4);
      expect(result.rows[0].rating_category).toBe('accuracy');
      expect(result.rows[0].rated_by).toBe('user_test_threads');
    });

    it('should validate rating range', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/feedback`)
        .send({ rating: 6 })
        .expect(400);

      expect(response.body.error).toBe('Rating must be a number between 1 and 5');
    });
  });

  describe('PUT /api/admin/addie/threads/messages/:messageId/outcome', () => {
    it('should set message outcome', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/outcome`)
        .send({
          outcome: 'resolved',
          user_sentiment: 'positive',
          intent_category: 'general_inquiry',
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT outcome, user_sentiment, intent_category FROM addie_thread_messages WHERE message_id = $1',
        [testMessageId]
      );
      expect(result.rows[0].outcome).toBe('resolved');
      expect(result.rows[0].user_sentiment).toBe('positive');
    });

    it('should validate outcome value', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/outcome`)
        .send({ outcome: 'invalid_outcome' })
        .expect(400);

      expect(response.body.error).toContain('Outcome must be one of');
    });
  });

  describe('PUT /api/admin/addie/threads/messages/:messageId/flag', () => {
    it('should flag a message', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/flag`)
        .send({ reason: 'Needs review' })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify in database
      const result = await pool.query(
        'SELECT flagged, flag_reason FROM addie_thread_messages WHERE message_id = $1',
        [testMessageId]
      );
      expect(result.rows[0].flagged).toBe(true);
      expect(result.rows[0].flag_reason).toBe('Needs review');
    });

    it('should require reason to flag', async () => {
      const response = await request(app)
        .put(`/api/admin/addie/threads/messages/${testMessageId}/flag`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Flag reason is required');
    });
  });

  // =========================================================================
  // Public Chat API Tests (using unified threads under the hood)
  // =========================================================================

  describe('GET /api/addie/chat/status', () => {
    it('should return chat status', async () => {
      const response = await request(app)
        .get('/api/addie/chat/status')
        .expect(200);

      expect(response.body).toHaveProperty('ready');
      expect(response.body).toHaveProperty('knowledge_ready');
    });
  });

  describe('GET /api/addie/chat/:conversationId', () => {
    let webThreadExternalId: string;

    beforeAll(async () => {
      // Create a web thread for testing
      webThreadExternalId = 'test-api-web-chat-' + Date.now();
      await pool.query(`
        INSERT INTO addie_threads (channel, external_id, user_type, user_id, user_display_name)
        VALUES ('web', $1, 'workos', 'user_test_threads', 'Test User')
      `, [webThreadExternalId]);

      // Add messages
      const threadResult = await pool.query(
        `SELECT thread_id FROM addie_threads WHERE external_id = $1`,
        [webThreadExternalId]
      );
      const threadId = threadResult.rows[0].thread_id;

      await pool.query(`
        INSERT INTO addie_thread_messages (thread_id, role, content, sequence_number)
        VALUES
          ($1, 'user', 'Web question', 1),
          ($1, 'assistant', 'Web answer', 2)
      `, [threadId]);
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM addie_threads WHERE external_id = $1`, [webThreadExternalId]);
    });

    it('should return conversation history', async () => {
      const response = await request(app)
        .get(`/api/addie/chat/${webThreadExternalId}`)
        .expect(200);

      expect(response.body.conversation_id).toBe(webThreadExternalId);
      expect(response.body.messages).toBeInstanceOf(Array);
      expect(response.body.messages.length).toBe(2);
    });

    it('should return 404 for non-existent conversation', async () => {
      // This is a valid UUID format but doesn't exist
      const fakeUuid = '12345678-1234-1234-1234-123456789012';
      const response = await request(app)
        .get(`/api/addie/chat/${fakeUuid}`)
        .expect(404);

      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 400 for invalid conversation ID format', async () => {
      const response = await request(app)
        .get('/api/addie/chat/not-a-valid-uuid')
        .expect(400);

      expect(response.body.error).toBe('Invalid conversation ID format');
    });
  });
});
