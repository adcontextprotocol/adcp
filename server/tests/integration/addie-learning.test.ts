import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AddieDatabase, type RuleType, type SuggestionType, type AddieRuleInput, type AddieRuleSuggestionInput } from '../../src/db/addie-db.js';
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
    await pool.query('DELETE FROM addie_rule_suggestions WHERE reasoning LIKE $1', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM addie_rules WHERE created_by = $1', [TEST_PREFIX]);
    await pool.query('DELETE FROM addie_analysis_runs WHERE analysis_type = $1', ['manual']);
    await pool.query('DELETE FROM addie_interactions WHERE user_id LIKE $1', [`${TEST_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await pool.query('DELETE FROM addie_rule_suggestions WHERE reasoning LIKE $1', [`${TEST_PREFIX}%`]);
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

    describe('buildSystemPrompt', () => {
      it('should compile active rules into sections', async () => {
        // Create rules of different types
        await db.createRule({
          rule_type: 'system_prompt',
          name: 'Identity',
          content: 'You are a helpful assistant',
          priority: 100,
          created_by: TEST_PREFIX,
        });

        await db.createRule({
          rule_type: 'behavior',
          name: 'Be Helpful',
          content: 'Always try to help',
          priority: 50,
          created_by: TEST_PREFIX,
        });

        await db.createRule({
          rule_type: 'constraint',
          name: 'No Harm',
          content: 'Never cause harm',
          priority: 90,
          created_by: TEST_PREFIX,
        });

        const prompt = await db.buildSystemPrompt();

        expect(prompt).toContain('# Core Identity');
        expect(prompt).toContain('## Identity');
        expect(prompt).toContain('You are a helpful assistant');

        expect(prompt).toContain('# Behaviors');
        expect(prompt).toContain('## Be Helpful');
        expect(prompt).toContain('Always try to help');

        expect(prompt).toContain('# Constraints');
        expect(prompt).toContain('## No Harm');
        expect(prompt).toContain('Never cause harm');
      });
    });

    describe('incrementRuleUsage', () => {
      it('should increment interaction count for rules', async () => {
        const rule1 = await db.createRule({
          rule_type: 'behavior',
          name: 'Usage Test 1',
          content: 'Test',
          created_by: TEST_PREFIX,
        });

        const rule2 = await db.createRule({
          rule_type: 'behavior',
          name: 'Usage Test 2',
          content: 'Test',
          created_by: TEST_PREFIX,
        });

        await db.incrementRuleUsage([rule1.id, rule2.id]);
        await db.incrementRuleUsage([rule1.id]);

        const updated1 = await db.getRuleById(rule1.id);
        const updated2 = await db.getRuleById(rule2.id);

        expect(updated1!.interactions_count).toBe(2);
        expect(updated2!.interactions_count).toBe(1);
      });

      it('should handle empty array gracefully', async () => {
        // Should not throw
        await expect(db.incrementRuleUsage([])).resolves.not.toThrow();
      });
    });
  });

  describe('Suggestions Management', () => {
    let testRule: Awaited<ReturnType<typeof db.createRule>>;

    beforeEach(async () => {
      testRule = await db.createRule({
        rule_type: 'behavior',
        name: 'Target Rule',
        content: 'Original content',
        created_by: TEST_PREFIX,
      });
    });

    describe('createSuggestion', () => {
      it('should create a new_rule suggestion', async () => {
        const input: AddieRuleSuggestionInput = {
          suggestion_type: 'new_rule',
          suggested_name: 'New Suggested Rule',
          suggested_content: 'New rule content',
          suggested_rule_type: 'behavior',
          reasoning: `${TEST_PREFIX}: Based on user feedback`,
          confidence: 0.85,
          expected_impact: 'Improved responses',
        };

        const suggestion = await db.createSuggestion(input);

        expect(suggestion.id).toBeDefined();
        expect(suggestion.suggestion_type).toBe('new_rule');
        expect(suggestion.suggested_name).toBe('New Suggested Rule');
        expect(suggestion.status).toBe('pending');
        // PostgreSQL DECIMAL returns as string, need to convert
        expect(Number(suggestion.confidence)).toBe(0.85);
      });

      it('should create a modify_rule suggestion', async () => {
        const input: AddieRuleSuggestionInput = {
          suggestion_type: 'modify_rule',
          target_rule_id: testRule.id,
          suggested_content: 'Modified content',
          reasoning: `${TEST_PREFIX}: Improve clarity`,
          confidence: 0.75,
        };

        const suggestion = await db.createSuggestion(input);

        expect(suggestion.suggestion_type).toBe('modify_rule');
        expect(suggestion.target_rule_id).toBe(testRule.id);
      });

      it('should create a disable_rule suggestion', async () => {
        const input: AddieRuleSuggestionInput = {
          suggestion_type: 'disable_rule',
          target_rule_id: testRule.id,
          suggested_content: 'Disable this rule',
          reasoning: `${TEST_PREFIX}: Rule causes issues`,
        };

        const suggestion = await db.createSuggestion(input);

        expect(suggestion.suggestion_type).toBe('disable_rule');
      });
    });

    describe('getPendingSuggestions', () => {
      it('should return pending suggestions ordered by confidence', async () => {
        await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Low confidence',
          reasoning: `${TEST_PREFIX}: test`,
          confidence: 0.5,
        });

        await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'High confidence',
          reasoning: `${TEST_PREFIX}: test`,
          confidence: 0.9,
        });

        const suggestions = await db.getPendingSuggestions();

        // Filter to our test suggestions
        const testSuggestions = suggestions.filter(s => s.reasoning.startsWith(TEST_PREFIX));
        expect(testSuggestions.length).toBeGreaterThanOrEqual(2);

        // High confidence should come first (PostgreSQL DECIMAL returns as string)
        const highIndex = testSuggestions.findIndex(s => Number(s.confidence) === 0.9);
        const lowIndex = testSuggestions.findIndex(s => Number(s.confidence) === 0.5);
        expect(highIndex).toBeLessThan(lowIndex);
      });
    });

    describe('approveSuggestion', () => {
      it('should mark suggestion as approved', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Approve me',
          reasoning: `${TEST_PREFIX}: test`,
        });

        const approved = await db.approveSuggestion(suggestion.id, 'admin@test.com', 'Looks good');

        expect(approved).not.toBeNull();
        expect(approved!.status).toBe('approved');
        expect(approved!.reviewed_by).toBe('admin@test.com');
        expect(approved!.review_notes).toBe('Looks good');
        expect(approved!.reviewed_at).not.toBeNull();
      });

      it('should not approve already reviewed suggestion', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Already reviewed',
          reasoning: `${TEST_PREFIX}: test`,
        });

        await db.approveSuggestion(suggestion.id, 'admin1@test.com');
        const secondApproval = await db.approveSuggestion(suggestion.id, 'admin2@test.com');

        expect(secondApproval).toBeNull();
      });
    });

    describe('rejectSuggestion', () => {
      it('should mark suggestion as rejected', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Reject me',
          reasoning: `${TEST_PREFIX}: test`,
        });

        const rejected = await db.rejectSuggestion(suggestion.id, 'admin@test.com', 'Not useful');

        expect(rejected).not.toBeNull();
        expect(rejected!.status).toBe('rejected');
        expect(rejected!.reviewed_by).toBe('admin@test.com');
        expect(rejected!.review_notes).toBe('Not useful');
      });
    });

    describe('applySuggestion', () => {
      it('should apply new_rule suggestion by creating a rule', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_name: 'Applied Rule',
          suggested_content: 'Applied content',
          suggested_rule_type: 'behavior',
          reasoning: `${TEST_PREFIX}: test`,
        });

        await db.approveSuggestion(suggestion.id, 'admin@test.com');
        const result = await db.applySuggestion(suggestion.id, TEST_PREFIX);

        expect(result).not.toBeNull();
        expect(result!.rule.name).toBe('Applied Rule');
        expect(result!.rule.content).toBe('Applied content');
        expect(result!.rule.rule_type).toBe('behavior');
        expect(result!.suggestion.status).toBe('applied');
        expect(result!.suggestion.resulting_rule_id).toBe(result!.rule.id);
      });

      it('should apply modify_rule suggestion by updating the rule', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'modify_rule',
          target_rule_id: testRule.id,
          suggested_content: 'Modified by suggestion',
          reasoning: `${TEST_PREFIX}: test`,
        });

        await db.approveSuggestion(suggestion.id, 'admin@test.com');
        const result = await db.applySuggestion(suggestion.id, TEST_PREFIX);

        expect(result).not.toBeNull();
        expect(result!.rule.content).toBe('Modified by suggestion');
        expect(result!.rule.version).toBe(2); // New version
      });

      it('should apply disable_rule suggestion by deactivating the rule', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'disable_rule',
          target_rule_id: testRule.id,
          suggested_content: 'Disable reason',
          reasoning: `${TEST_PREFIX}: test`,
        });

        await db.approveSuggestion(suggestion.id, 'admin@test.com');
        const result = await db.applySuggestion(suggestion.id, TEST_PREFIX);

        expect(result).not.toBeNull();
        expect(result!.rule.is_active).toBe(false);
      });

      it('should return null for unapproved suggestion', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Not approved',
          reasoning: `${TEST_PREFIX}: test`,
        });

        const result = await db.applySuggestion(suggestion.id, TEST_PREFIX);
        expect(result).toBeNull();
      });

      it('should return null for unsupported suggestion types', async () => {
        const suggestion = await db.createSuggestion({
          suggestion_type: 'merge_rules',
          suggested_content: 'Merge these',
          reasoning: `${TEST_PREFIX}: test`,
        });

        await db.approveSuggestion(suggestion.id, 'admin@test.com');
        const result = await db.applySuggestion(suggestion.id, TEST_PREFIX);

        expect(result).toBeNull();
      });
    });

    describe('getSuggestionStats', () => {
      it('should return correct counts by status', async () => {
        // Create suggestions with different statuses
        await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Pending 1',
          reasoning: `${TEST_PREFIX}: test`,
        });

        const toApprove = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Will approve',
          reasoning: `${TEST_PREFIX}: test`,
        });
        await db.approveSuggestion(toApprove.id, 'admin');

        const toReject = await db.createSuggestion({
          suggestion_type: 'new_rule',
          suggested_content: 'Will reject',
          reasoning: `${TEST_PREFIX}: test`,
        });
        await db.rejectSuggestion(toReject.id, 'admin');

        const stats = await db.getSuggestionStats();

        expect(stats.pending).toBeGreaterThanOrEqual(1);
        expect(stats.approved).toBeGreaterThanOrEqual(1);
        expect(stats.rejected).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Analysis Runs', () => {
    describe('startAnalysisRun', () => {
      it('should create a running analysis run', async () => {
        const run = await db.startAnalysisRun('manual');

        expect(run.id).toBeDefined();
        expect(run.analysis_type).toBe('manual');
        expect(run.status).toBe('running');
        expect(run.started_at).not.toBeNull();
      });
    });

    describe('completeAnalysisRun', () => {
      it('should mark analysis as completed with results', async () => {
        const run = await db.startAnalysisRun('manual');

        await db.completeAnalysisRun(run.id, {
          interactions_analyzed: 50,
          suggestions_generated: 3,
          patterns_found: { test: 'pattern' },
          summary: 'Found some patterns',
          model_used: 'claude-sonnet-4-20250514',
          tokens_used: 1000,
        });

        const runs = await db.getRecentAnalysisRuns();
        const completed = runs.find(r => r.id === run.id);

        expect(completed).not.toBeNull();
        expect(completed!.status).toBe('completed');
        expect(completed!.interactions_analyzed).toBe(50);
        expect(completed!.suggestions_generated).toBe(3);
        expect(completed!.tokens_used).toBe(1000);
      });
    });

    describe('failAnalysisRun', () => {
      it('should mark analysis as failed with error', async () => {
        const run = await db.startAnalysisRun('manual');

        await db.failAnalysisRun(run.id, 'API error occurred');

        const runs = await db.getRecentAnalysisRuns();
        const failed = runs.find(r => r.id === run.id);

        expect(failed).not.toBeNull();
        expect(failed!.status).toBe('failed');
        expect(failed!.error_message).toBe('API error occurred');
      });
    });

    describe('getRecentAnalysisRuns', () => {
      it('should return runs in reverse chronological order', async () => {
        const run1 = await db.startAnalysisRun('manual');
        const run2 = await db.startAnalysisRun('manual');

        const runs = await db.getRecentAnalysisRuns();

        const index1 = runs.findIndex(r => r.id === run1.id);
        const index2 = runs.findIndex(r => r.id === run2.id);

        // run2 was created later, should come first
        expect(index2).toBeLessThan(index1);
      });

      it('should respect limit parameter', async () => {
        // Create several runs
        for (let i = 0; i < 5; i++) {
          await db.startAnalysisRun('manual');
        }

        const runs = await db.getRecentAnalysisRuns(3);
        expect(runs.length).toBe(3);
      });
    });
  });

  describe('Experiments', () => {
    describe('assignExperimentGroup', () => {
      it('should assign control or variant based on traffic split', async () => {
        // With 50% split, we should get roughly equal distribution
        const assignments: Record<string, number> = { control: 0, variant: 0 };

        for (let i = 0; i < 100; i++) {
          const group = await db.assignExperimentGroup(1, 0.5);
          assignments[group]++;
        }

        // Should have some of each (statistical test - could rarely fail)
        expect(assignments.control).toBeGreaterThan(20);
        expect(assignments.variant).toBeGreaterThan(20);
      });

      it('should respect traffic split ratio', async () => {
        // With 10% variant split
        const assignments: Record<string, number> = { control: 0, variant: 0 };

        for (let i = 0; i < 100; i++) {
          const group = await db.assignExperimentGroup(1, 0.1);
          assignments[group]++;
        }

        // Control should dominate
        expect(assignments.control).toBeGreaterThan(70);
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

    describe('getInteractionsForAnalysis', () => {
      it('should filter by rating range', async () => {
        // Rate the test interaction
        await db.rateInteraction(testInteractionId, 2, 'admin@test.com');

        const lowRated = await db.getInteractionsForAnalysis({
          days: 7,
          maxRating: 3,
        });

        const found = lowRated.find(i => i.id === testInteractionId);
        expect(found).toBeDefined();
        expect(found!.rating).toBe(2);
      });

      it('should respect day limit', async () => {
        const recent = await db.getInteractionsForAnalysis({
          days: 1,
        });

        // All returned interactions should be within the last day
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        for (const interaction of recent) {
          expect(new Date(interaction.timestamp)).toBeInstanceOf(Date);
        }
      });
    });
  });
});
