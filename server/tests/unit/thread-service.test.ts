import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Import the ThreadService class and types
import {
  ThreadService,
  type CreateThreadInput,
  type CreateMessageInput,
  type ThreadListFilters,
} from '../../src/addie/thread-service.js';

describe('ThreadService Unit Tests', () => {
  let pool: Pool;
  let threadService: ThreadService;
  const TEST_THREAD_EXTERNAL_ID = 'test-channel:test-thread-ts';
  const TEST_WEB_EXTERNAL_ID = 'test-web-conversation-uuid';

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Create a fresh ThreadService instance
    threadService = new ThreadService();
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query(`DELETE FROM addie_threads WHERE external_id LIKE 'test-%'`);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up threads before each test
    await pool.query(`DELETE FROM addie_threads WHERE external_id LIKE 'test-%'`);
  });

  describe('getOrCreateThread', () => {
    it('should create a new thread when none exists', async () => {
      const input: CreateThreadInput = {
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
        user_id: 'U123456',
        user_display_name: 'Test User',
        context: { team_id: 'T123' },
      };

      const thread = await threadService.getOrCreateThread(input);

      expect(thread).toBeDefined();
      expect(thread.thread_id).toBeDefined();
      expect(thread.channel).toBe('slack');
      expect(thread.external_id).toBe(TEST_THREAD_EXTERNAL_ID);
      expect(thread.user_type).toBe('slack');
      expect(thread.user_id).toBe('U123456');
      expect(thread.user_display_name).toBe('Test User');
      expect(thread.message_count).toBe(0);
      expect(thread.flagged).toBe(false);
      expect(thread.reviewed).toBe(false);
    });

    it('should return existing thread on duplicate external_id', async () => {
      const input: CreateThreadInput = {
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
        user_id: 'U123456',
      };

      const thread1 = await threadService.getOrCreateThread(input);
      const thread2 = await threadService.getOrCreateThread(input);

      expect(thread1.thread_id).toBe(thread2.thread_id);
    });

    it('should create separate threads for different channels with same external_id', async () => {
      const slackThread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: 'same-external-id',
        user_type: 'slack',
      });

      const webThread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: 'same-external-id',
        user_type: 'workos',
      });

      expect(slackThread.thread_id).not.toBe(webThread.thread_id);

      // Clean up
      await pool.query(`DELETE FROM addie_threads WHERE external_id = 'same-external-id'`);
    });

    it('should handle web channel with anonymous user', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: TEST_WEB_EXTERNAL_ID,
        user_type: 'anonymous',
        context: { ip_hash: 'abc123', user_agent: 'Test Browser' },
      });

      expect(thread.channel).toBe('web');
      expect(thread.user_type).toBe('anonymous');
      expect(thread.user_id).toBeNull();
    });

    it('should handle impersonation fields', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: 'test-impersonation-thread',
        user_type: 'workos',
        user_id: 'user_real',
        impersonator_user_id: 'admin@test.com',
        impersonation_reason: 'Testing',
      });

      expect(thread.impersonator_user_id).toBe('admin@test.com');
      expect(thread.impersonation_reason).toBe('Testing');

      // Clean up
      await pool.query(`DELETE FROM addie_threads WHERE external_id = 'test-impersonation-thread'`);
    });
  });

  describe('addMessage', () => {
    it('should add a message to a thread', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
        user_id: 'U123456',
      });

      const message = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: 'Hello, Addie!',
        content_sanitized: 'Hello, Addie!',
      });

      expect(message).toBeDefined();
      expect(message.message_id).toBeDefined();
      expect(message.thread_id).toBe(thread.thread_id);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, Addie!');
      expect(message.sequence_number).toBe(1);
    });

    it('should auto-increment sequence numbers', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      const msg1 = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: 'First message',
      });

      const msg2 = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: 'Second message',
      });

      const msg3 = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: 'Third message',
      });

      expect(msg1.sequence_number).toBe(1);
      expect(msg2.sequence_number).toBe(2);
      expect(msg3.sequence_number).toBe(3);
    });

    it('should track tool usage', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: 'Search for something',
      });

      const assistantMsg = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: 'I found this for you.',
        tools_used: ['search_knowledge', 'get_member_info'],
        tool_calls: [
          { name: 'search_knowledge', input: { query: 'something' }, result: { found: true } },
        ],
        model: 'claude-sonnet-4-20250514',
        latency_ms: 500,
      });

      expect(assistantMsg.tools_used).toContain('search_knowledge');
      expect(assistantMsg.model).toBe('claude-sonnet-4-20250514');
      expect(assistantMsg.latency_ms).toBe(500);
    });

    it('should handle flagged messages', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      const msg = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: 'Some content',
        flagged: true,
        flag_reason: 'Potentially sensitive',
      });

      expect(msg.flagged).toBe(true);
      expect(msg.flag_reason).toBe('Potentially sensitive');
    });
  });

  describe('getThreadMessages', () => {
    it('should return messages in order', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'First' });
      await threadService.addMessage({ thread_id: thread.thread_id, role: 'assistant', content: 'Second' });
      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'Third' });

      const messages = await threadService.getThreadMessages(thread.thread_id);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });
  });

  describe('addMessageFeedback', () => {
    it('should add feedback to a message', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: TEST_WEB_EXTERNAL_ID,
        user_type: 'workos',
      });

      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'Question' });
      const assistantMsg = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: 'Answer',
      });

      await threadService.addMessageFeedback(assistantMsg.message_id, {
        rating: 5,
        rating_category: 'helpfulness',
        rating_notes: 'Very helpful!',
        feedback_tags: ['clear', 'accurate'],
        rated_by: 'user_test',
      });

      // Fetch the message again to verify
      const messages = await threadService.getThreadMessages(thread.thread_id);
      const ratedMsg = messages.find(m => m.message_id === assistantMsg.message_id);

      expect(ratedMsg?.rating).toBe(5);
      expect(ratedMsg?.rating_category).toBe('helpfulness');
      expect(ratedMsg?.rated_by).toBe('user_test');
    });
  });

  describe('reviewThread', () => {
    it('should mark thread as reviewed', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      await threadService.reviewThread(thread.thread_id, 'admin@test.com', 'Looks good');

      const updatedThread = await threadService.getThread(thread.thread_id);

      expect(updatedThread?.reviewed).toBe(true);
      expect(updatedThread?.reviewed_by).toBe('admin@test.com');
      expect(updatedThread?.review_notes).toBe('Looks good');
      expect(updatedThread?.reviewed_at).toBeDefined();
    });
  });

  describe('flagThread / unflagThread', () => {
    it('should flag and unflag a thread', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      // Flag the thread
      await threadService.flagThread(thread.thread_id, 'Suspicious activity');

      let updatedThread = await threadService.getThread(thread.thread_id);
      expect(updatedThread?.flagged).toBe(true);
      expect(updatedThread?.flag_reason).toBe('Suspicious activity');

      // Unflag the thread
      await threadService.unflagThread(thread.thread_id);

      updatedThread = await threadService.getThread(thread.thread_id);
      expect(updatedThread?.flagged).toBe(false);
      expect(updatedThread?.flag_reason).toBeNull();
    });
  });

  describe('listThreads', () => {
    beforeEach(async () => {
      // Create several test threads
      await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: 'test-list-1',
        user_type: 'slack',
        user_id: 'U123',
      });

      await threadService.getOrCreateThread({
        channel: 'web',
        external_id: 'test-list-2',
        user_type: 'workos',
        user_id: 'user_abc',
      });

      // Create and flag a thread
      const flaggedThread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: 'test-list-3-flagged',
        user_type: 'slack',
      });
      await threadService.flagThread(flaggedThread.thread_id, 'Test flag');
    });

    afterEach(async () => {
      await pool.query(`DELETE FROM addie_threads WHERE external_id LIKE 'test-list-%'`);
    });

    it('should list threads without filters', async () => {
      const threads = await threadService.listThreads({ limit: 10 });

      expect(threads.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by channel', async () => {
      const slackThreads = await threadService.listThreads({ channel: 'slack' });
      const webThreads = await threadService.listThreads({ channel: 'web' });

      expect(slackThreads.every(t => t.channel === 'slack')).toBe(true);
      expect(webThreads.every(t => t.channel === 'web')).toBe(true);
    });

    it('should filter flagged threads', async () => {
      const flaggedThreads = await threadService.listThreads({ flagged_only: true });

      expect(flaggedThreads.every(t => t.flagged)).toBe(true);
      expect(flaggedThreads.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getStats', () => {
    it('should return overall statistics', async () => {
      // Create some test data
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: 'test-stats-thread',
        user_type: 'slack',
        user_id: 'U123',
      });

      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'Test' });
      await threadService.addMessage({ thread_id: thread.thread_id, role: 'assistant', content: 'Response' });

      const stats = await threadService.getStats();

      expect(stats).toHaveProperty('total_threads');
      expect(stats).toHaveProperty('total_messages');
      expect(stats).toHaveProperty('unique_users');
      expect(stats).toHaveProperty('threads_last_24h');
      expect(stats).toHaveProperty('flagged_threads');
      expect(stats).toHaveProperty('unreviewed_threads');
      expect(typeof stats.total_threads).toBe('number');
      expect(typeof stats.total_messages).toBe('number');

      // Clean up
      await pool.query(`DELETE FROM addie_threads WHERE external_id = 'test-stats-thread'`);
    });
  });

  describe('getChannelStats', () => {
    it('should return stats by channel', async () => {
      const channelStats = await threadService.getChannelStats();

      expect(channelStats).toBeInstanceOf(Array);
      // Each channel stat should have required fields
      channelStats.forEach(stat => {
        expect(stat).toHaveProperty('channel');
        expect(stat).toHaveProperty('total_threads');
        expect(stat).toHaveProperty('total_messages');
      });
    });
  });

  describe('getThreadByExternalId', () => {
    it('should find thread by channel and external_id', async () => {
      const created = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: TEST_WEB_EXTERNAL_ID,
        user_type: 'workos',
        user_id: 'user_test',
      });

      const found = await threadService.getThreadByExternalId('web', TEST_WEB_EXTERNAL_ID);

      expect(found).toBeDefined();
      expect(found?.thread_id).toBe(created.thread_id);
    });

    it('should return null for non-existent thread', async () => {
      const notFound = await threadService.getThreadByExternalId('web', 'nonexistent-id');

      expect(notFound).toBeNull();
    });
  });

  describe('getThreadWithMessages', () => {
    it('should return thread with all messages', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: TEST_THREAD_EXTERNAL_ID,
        user_type: 'slack',
      });

      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'Hello' });
      await threadService.addMessage({ thread_id: thread.thread_id, role: 'assistant', content: 'Hi!' });

      const threadWithMessages = await threadService.getThreadWithMessages(thread.thread_id);

      expect(threadWithMessages).toBeDefined();
      expect(threadWithMessages?.messages).toHaveLength(2);
      expect(threadWithMessages?.channel).toBe('slack');
    });

    it('should return null for non-existent thread', async () => {
      const result = await threadService.getThreadWithMessages('00000000-0000-0000-0000-000000000000');

      expect(result).toBeNull();
    });
  });

  describe('setMessageOutcome', () => {
    it('should set outcome and sentiment on a message', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: TEST_WEB_EXTERNAL_ID,
        user_type: 'workos',
      });

      await threadService.addMessage({ thread_id: thread.thread_id, role: 'user', content: 'Question' });
      const assistantMsg = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: 'Answer',
      });

      await threadService.setMessageOutcome(
        assistantMsg.message_id,
        'resolved',
        'positive',
        'general_question'
      );

      const messages = await threadService.getThreadMessages(thread.thread_id);
      const updatedMsg = messages.find(m => m.message_id === assistantMsg.message_id);

      expect(updatedMsg?.outcome).toBe('resolved');
      expect(updatedMsg?.user_sentiment).toBe('positive');
      expect(updatedMsg?.intent_category).toBe('general_question');
    });
  });
});
