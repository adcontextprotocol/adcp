import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AddieDatabase, type RuleType, type AddieRuleInput } from '../../src/db/addie-db.js';
import type { Pool } from 'pg';

const TEST_PREFIX = 'addie_learning_test';

describe('Addie Learning System Integration Tests', () => {
  let pool: Pool;
  let db: AddieDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });

    await runMigrations();
    db = new AddieDatabase();
  });

  afterAll(async () => {
    // Clean up all test data
    await pool.query('DELETE FROM addie_rules WHERE created_by = $1', [TEST_PREFIX]);
    await pool.query('DELETE FROM addie_interactions WHERE user_id LIKE $1', [`${TEST_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await pool.query('DELETE FROM addie_rules WHERE created_by = $1', [TEST_PREFIX]);
  });

  describe('Rules Management', () => {
    describe('createRule', () => {
      it('should create a rule with all fields', async () => {
        const input: AddieRuleInput = {
          rule_type: 'behavior',
          name: 'Test Rule',
          description: 'A test rule for testing',
          content: 'Do something specific',
          priority: 50,
          created_by: TEST_PREFIX,
        };

        const rule = await db.createRule(input);

        expect(rule.id).toBeDefined();
        expect(rule.rule_type).toBe('behavior');
        expect(rule.name).toBe('Test Rule');
        expect(rule.description).toBe('A test rule for testing');
        expect(rule.content).toBe('Do something specific');
        expect(rule.priority).toBe(50);
        expect(rule.is_active).toBe(true);
        expect(rule.version).toBe(1);
        expect(rule.interactions_count).toBe(0);
        expect(rule.positive_ratings).toBe(0);
        expect(rule.negative_ratings).toBe(0);
      });

      it('should create a rule with minimal fields', async () => {
        const input: AddieRuleInput = {
          rule_type: 'constraint',
          name: 'Minimal Rule',
          content: 'Never do this',
          created_by: TEST_PREFIX,
        };

        const rule = await db.createRule(input);

        expect(rule.id).toBeDefined();
        expect(rule.rule_type).toBe('constraint');
        expect(rule.name).toBe('Minimal Rule');
        expect(rule.description).toBeNull();
        expect(rule.priority).toBe(0);
      });

      it('should validate rule_type enum', async () => {
        const input: AddieRuleInput = {
          rule_type: 'invalid_type' as RuleType,
          name: 'Invalid Rule',
          content: 'Content',
          created_by: TEST_PREFIX,
        };

        await expect(db.createRule(input)).rejects.toThrow();
      });
    });

    describe('getRuleById', () => {
      it('should retrieve a rule by ID', async () => {
        const created = await db.createRule({
          rule_type: 'knowledge',
          name: 'Knowledge Rule',
          content: 'Some knowledge',
          created_by: TEST_PREFIX,
        });

        const retrieved = await db.getRuleById(created.id);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(created.id);
        expect(retrieved!.name).toBe('Knowledge Rule');
      });

      it('should return null for non-existent ID', async () => {
        const retrieved = await db.getRuleById(999999);
        expect(retrieved).toBeNull();
      });
    });

    describe('getActiveRules', () => {
      it('should return only active rules ordered by priority', async () => {
        // Create multiple rules with different priorities
        await db.createRule({
          rule_type: 'behavior',
          name: 'Low Priority',
          content: 'Low',
          priority: 10,
          created_by: TEST_PREFIX,
        });

        await db.createRule({
          rule_type: 'behavior',
          name: 'High Priority',
          content: 'High',
          priority: 100,
          created_by: TEST_PREFIX,
        });

        const rules = await db.getActiveRules();

        // Find our test rules
        const testRules = rules.filter(r => r.created_by === TEST_PREFIX);
        expect(testRules.length).toBeGreaterThanOrEqual(2);

        // Verify priority ordering (highest first)
        const highIndex = testRules.findIndex(r => r.name === 'High Priority');
        const lowIndex = testRules.findIndex(r => r.name === 'Low Priority');
        expect(highIndex).toBeLessThan(lowIndex);
      });

      it('should not return inactive rules', async () => {
        const rule = await db.createRule({
          rule_type: 'behavior',
          name: 'Soon Inactive',
          content: 'Will be deactivated',
          created_by: TEST_PREFIX,
        });

        await db.setRuleActive(rule.id, false);

        const activeRules = await db.getActiveRules();
        const found = activeRules.find(r => r.id === rule.id);
        expect(found).toBeUndefined();
      });
    });

    describe('updateRule', () => {
      it('should create a new version when updating', async () => {
        const original = await db.createRule({
          rule_type: 'behavior',
          name: 'Original Rule',
          content: 'Original content',
          created_by: TEST_PREFIX,
        });

        const updated = await db.updateRule(original.id, {
          content: 'Updated content',
        }, TEST_PREFIX);

        expect(updated).not.toBeNull();
        expect(updated!.id).not.toBe(original.id); // New ID
        expect(updated!.version).toBe(2);
        expect(updated!.supersedes_rule_id).toBe(original.id);
        expect(updated!.content).toBe('Updated content');
        expect(updated!.name).toBe('Original Rule'); // Preserved

        // Original should now be inactive
        const oldRule = await db.getRuleById(original.id);
        expect(oldRule!.is_active).toBe(false);
      });

      it('should return null for non-existent rule', async () => {
        const updated = await db.updateRule(999999, { content: 'New' }, TEST_PREFIX);
        expect(updated).toBeNull();
      });
    });

    describe('setRuleActive', () => {
      it('should toggle rule active status', async () => {
        const rule = await db.createRule({
          rule_type: 'constraint',
          name: 'Toggle Test',
          content: 'Test',
          created_by: TEST_PREFIX,
        });

        expect(rule.is_active).toBe(true);

        const deactivated = await db.setRuleActive(rule.id, false);
        expect(deactivated!.is_active).toBe(false);

        const reactivated = await db.setRuleActive(rule.id, true);
        expect(reactivated!.is_active).toBe(true);
      });
    });

    describe('deleteRule', () => {
      it('should soft delete a rule', async () => {
        const rule = await db.createRule({
          rule_type: 'behavior',
          name: 'Delete Me',
          content: 'To be deleted',
          created_by: TEST_PREFIX,
        });

        const deleted = await db.deleteRule(rule.id);
        expect(deleted).toBe(true);

        // Should still exist but be inactive
        const retrieved = await db.getRuleById(rule.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.is_active).toBe(false);
      });

      it('should return false for non-existent rule', async () => {
        const deleted = await db.deleteRule(999999);
        // Since it's an UPDATE, it returns false when no rows affected
        expect(deleted).toBe(false);
      });
    });

  });

  describe('Interaction Rating', () => {
    let testInteractionId: string;

    beforeEach(async () => {
      // Create a test interaction
      testInteractionId = `${TEST_PREFIX}_${Date.now()}`;

      // We need to create a rule first to test the rating propagation
      const rule = await db.createRule({
        rule_type: 'behavior',
        name: 'Rating Test Rule',
        content: 'Test content',
        created_by: TEST_PREFIX,
      });

      await pool.query(
        `INSERT INTO addie_interactions (
          id, event_type, channel_id, user_id,
          input_text, input_sanitized, output_text,
          tools_used, model, latency_ms, flagged,
          active_rules_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          testInteractionId,
          'mention',
          'C123',
          `${TEST_PREFIX}_user`,
          'Test input',
          'Test input sanitized',
          'Test output',
          [],
          'claude-3',
          100,
          false,
          JSON.stringify({ rule_ids: [rule.id] }),
        ]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM addie_interactions WHERE id = $1', [testInteractionId]);
    });

    describe('rateInteraction', () => {
      it('should rate an interaction', async () => {
        await db.rateInteraction(testInteractionId, 5, 'admin@test.com', {
          notes: 'Great response',
          outcome: 'resolved',
          user_sentiment: 'positive',
        });

        const result = await pool.query(
          'SELECT rating, rating_by, rating_notes, outcome, user_sentiment FROM addie_interactions WHERE id = $1',
          [testInteractionId]
        );

        expect(result.rows[0].rating).toBe(5);
        expect(result.rows[0].rating_by).toBe('admin@test.com');
        expect(result.rows[0].rating_notes).toBe('Great response');
        expect(result.rows[0].outcome).toBe('resolved');
        expect(result.rows[0].user_sentiment).toBe('positive');
      });
    });

  });

  describe('Recent News', () => {
    const TEST_NEWS_PREFIX = 'test_news_';

    beforeEach(async () => {
      // Clean up test data
      await pool.query('DELETE FROM addie_knowledge WHERE title LIKE $1', [`${TEST_NEWS_PREFIX}%`]);
    });

    afterEach(async () => {
      await pool.query('DELETE FROM addie_knowledge WHERE title LIKE $1', [`${TEST_NEWS_PREFIX}%`]);
    });

    async function insertTestArticle(options: {
      title: string;
      daysAgo?: number;
      qualityScore?: number;
      tags?: string[];
      topic?: string;
    }) {
      const fetchedAt = new Date();
      if (options.daysAgo) {
        fetchedAt.setDate(fetchedAt.getDate() - options.daysAgo);
      }

      await pool.query(
        `INSERT INTO addie_knowledge (
          title, category, content, source_url, source_type, fetch_status,
          last_fetched_at, quality_score, relevance_tags, summary, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `${TEST_NEWS_PREFIX}${options.title}`,
          'news',
          options.topic ? `Content about ${options.topic}` : 'Test article content',
          `https://example.com/${options.title.toLowerCase().replace(/\s+/g, '-')}`,
          'rss',
          'success',
          fetchedAt,
          options.qualityScore ?? 4,
          options.tags ?? [],
          `Summary of ${options.title}`,
          true,
        ]
      );
    }

    describe('getRecentNews', () => {
      it('should return recent articles sorted by date', async () => {
        await insertTestArticle({ title: 'Old Article', daysAgo: 3 });
        await insertTestArticle({ title: 'New Article', daysAgo: 1 });
        await insertTestArticle({ title: 'Newest Article', daysAgo: 0 });

        const results = await db.getRecentNews({ days: 7 });

        const testResults = results.filter(r => r.title.startsWith(TEST_NEWS_PREFIX));
        expect(testResults.length).toBe(3);
        // Should be sorted by date, newest first
        expect(testResults[0].title).toContain('Newest');
        expect(testResults[1].title).toContain('New Article');
        expect(testResults[2].title).toContain('Old');
      });

      it('should filter by time window', async () => {
        await insertTestArticle({ title: 'Recent', daysAgo: 2 });
        await insertTestArticle({ title: 'Too Old', daysAgo: 10 });

        const results = await db.getRecentNews({ days: 7 });

        const testResults = results.filter(r => r.title.startsWith(TEST_NEWS_PREFIX));
        expect(testResults.length).toBe(1);
        expect(testResults[0].title).toContain('Recent');
      });

      it('should filter by minimum quality score', async () => {
        await insertTestArticle({ title: 'High Quality', qualityScore: 5 });
        await insertTestArticle({ title: 'Medium Quality', qualityScore: 3 });
        await insertTestArticle({ title: 'Low Quality', qualityScore: 2 });

        // Default minQuality is 3
        const results = await db.getRecentNews({ days: 7 });

        const testResults = results.filter(r => r.title.startsWith(TEST_NEWS_PREFIX));
        expect(testResults.length).toBe(2);
        expect(testResults.find(r => r.title.includes('Low'))).toBeUndefined();
      });

      it('should filter by relevance tags', async () => {
        await insertTestArticle({ title: 'MCP Article', tags: ['mcp', 'protocol'] });
        await insertTestArticle({ title: 'A2A Article', tags: ['a2a', 'agents'] });
        await insertTestArticle({ title: 'General Article', tags: ['industry-trend'] });

        const results = await db.getRecentNews({ days: 7, tags: ['mcp'] });

        const testResults = results.filter(r => r.title.startsWith(TEST_NEWS_PREFIX));
        expect(testResults.length).toBe(1);
        expect(testResults[0].title).toContain('MCP');
      });

      it('should filter by topic using full-text search', async () => {
        await insertTestArticle({ title: 'Agentic Article', topic: 'agentic advertising and AI agents' });
        await insertTestArticle({ title: 'CTV Article', topic: 'connected TV and streaming' });

        const results = await db.getRecentNews({ days: 7, topic: 'agentic advertising' });

        const testResults = results.filter(r => r.title.startsWith(TEST_NEWS_PREFIX));
        expect(testResults.length).toBe(1);
        expect(testResults[0].title).toContain('Agentic');
      });

      it('should respect limit parameter', async () => {
        // Use unique tags to isolate test data from production data
        const isolationTag = 'test-limit-isolation';
        await insertTestArticle({ title: 'Article 1', tags: [isolationTag] });
        await insertTestArticle({ title: 'Article 2', tags: [isolationTag] });
        await insertTestArticle({ title: 'Article 3', tags: [isolationTag] });

        const results = await db.getRecentNews({ days: 7, limit: 2, tags: [isolationTag] });

        expect(results.length).toBe(2);
      });

      it('should return empty array when no matching articles', async () => {
        const results = await db.getRecentNews({ days: 1, topic: 'nonexistent-topic-xyz' });

        expect(results).toEqual([]);
      });

      it('should include article metadata in results', async () => {
        await insertTestArticle({
          title: 'Full Article',
          qualityScore: 5,
          tags: ['mcp', 'test'],
        });

        const results = await db.getRecentNews({ days: 7 });

        const article = results.find(r => r.title.includes('Full Article'));
        expect(article).toBeDefined();
        expect(article!.source_url).toContain('full-article');
        expect(article!.summary).toContain('Summary');
        expect(article!.quality_score).toBe(5);
        expect(article!.relevance_tags).toContain('mcp');
        expect(article!.last_fetched_at).toBeInstanceOf(Date);
      });
    });
  });
});
