import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetWorkingGroupBySlug } = vi.hoisted(() => ({
  mockGetWorkingGroupBySlug: vi.fn(),
}));

// Mock the dependencies before importing the module under test
vi.mock('../../src/db/conversation-insights-db.js', () => ({
  createInsight: vi.fn(),
  getInsightByWeek: vi.fn(),
  markPosted: vi.fn(),
  markFailed: vi.fn(),
  listInsights: vi.fn(),
}));

vi.mock('../../src/addie/services/conversation-insights-builder.js', () => ({
  buildConversationInsights: vi.fn(),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupBySlug = mockGetWorkingGroupBySlug;
  },
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runConversationInsightsJob } from '../../src/addie/jobs/conversation-insights.js';
import { getInsightByWeek, createInsight, markPosted } from '../../src/db/conversation-insights-db.js';
import { buildConversationInsights } from '../../src/addie/services/conversation-insights-builder.js';
import { sendChannelMessage } from '../../src/slack/client.js';

describe('Conversation Insights Job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('schedule gating', () => {
    it('skips when not forced and not Monday', async () => {
      // A Wednesday
      vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
        this: Date,
        locale?: string,
        options?: Intl.DateTimeFormatOptions,
      ) {
        if (options?.weekday === 'short') return 'Wed';
        if (options?.hour === 'numeric') return '8';
        return this.toString();
      });

      const result = await runConversationInsightsJob();
      expect(result.generated).toBe(false);
      expect(result.posted).toBe(false);
      expect(getInsightByWeek).not.toHaveBeenCalled();
    });

    it('skips when Monday but outside 8-9am ET', async () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
        this: Date,
        locale?: string,
        options?: Intl.DateTimeFormatOptions,
      ) {
        if (options?.weekday === 'short') return 'Mon';
        if (options?.hour === 'numeric') return '14'; // 2pm
        return this.toString();
      });

      const result = await runConversationInsightsJob();
      expect(result.generated).toBe(false);
      expect(getInsightByWeek).not.toHaveBeenCalled();
    });

    it('runs when forced regardless of day/time', async () => {
      vi.mocked(getInsightByWeek).mockResolvedValue(null);
      vi.mocked(buildConversationInsights).mockResolvedValue(null);

      const result = await runConversationInsightsJob({ force: true });
      expect(result.skipped).toBe(true);
      // It proceeded past the schedule gate and called the builder
      expect(buildConversationInsights).toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('skips if insights already exist for the week', async () => {
      vi.mocked(getInsightByWeek).mockResolvedValue({
        id: 1,
        week_start: new Date('2026-03-16'),
        week_end: new Date('2026-03-22'),
        status: 'posted',
        stats: {} as any,
        analysis: {} as any,
        model_used: 'test',
        tokens_input: 100,
        tokens_output: 200,
        latency_ms: 1000,
        slack_channel_id: 'C123',
        slack_message_ts: '123.456',
        created_at: new Date(),
      });

      const result = await runConversationInsightsJob({ force: true });
      expect(result.generated).toBe(false);
      expect(buildConversationInsights).not.toHaveBeenCalled();
    });
  });

  describe('generation', () => {
    it('marks skipped when builder returns null (insufficient data)', async () => {
      vi.mocked(getInsightByWeek).mockResolvedValue(null);
      vi.mocked(buildConversationInsights).mockResolvedValue(null);

      const result = await runConversationInsightsJob({ force: true });
      expect(result.skipped).toBe(true);
      expect(result.generated).toBe(false);
    });

    it('creates insight and posts to Slack on success', async () => {
      vi.mocked(getInsightByWeek).mockResolvedValue(null);
      vi.mocked(buildConversationInsights).mockResolvedValue({
        stats: {
          total_threads: 25,
          total_messages: 100,
          unique_users: 15,
          by_channel: { slack: 20, web: 5 },
          avg_rating: 4.2,
          sentiment_breakdown: { positive: 10, neutral: 12, negative: 3 },
          outcome_breakdown: { resolved: 18, unresolved: 7 },
          escalation_count: 2,
          escalation_by_category: { capability_gap: 1, needs_human_action: 1 },
        },
        analysis: {
          executive_summary: 'Active week with strong engagement.',
          question_themes: [{ theme: 'AdCP setup', count: 8, description: 'Questions about getting started', example_questions: ['How do I set up adagents.json?'] }],
          documentation_gaps: [{ topic: 'adagents.json', evidence: 'Multiple questions about config format', suggested_action: 'Add quickstart guide' }],
          training_gaps: [],
          addie_improvements: [],
          escalation_patterns: [],
        },
        model: 'claude-sonnet',
        tokensInput: 5000,
        tokensOutput: 2000,
        latencyMs: 3000,
      });

      const mockRecord = {
        id: 1,
        week_start: new Date('2026-03-16'),
        week_end: new Date('2026-03-22'),
        status: 'generated' as const,
        stats: {
          total_threads: 25,
          total_messages: 100,
          unique_users: 15,
          by_channel: { slack: 20, web: 5 },
          avg_rating: 4.2,
          sentiment_breakdown: { positive: 10, neutral: 12, negative: 3 },
          outcome_breakdown: { resolved: 18, unresolved: 7 },
          escalation_count: 2,
          escalation_by_category: { capability_gap: 1, needs_human_action: 1 },
        },
        analysis: {
          executive_summary: 'Active week with strong engagement.',
          question_themes: [{ theme: 'AdCP setup', count: 8, description: 'Getting started questions', example_questions: ['How do I set up adagents.json?'] }],
          documentation_gaps: [{ topic: 'adagents.json', evidence: 'Multiple questions', suggested_action: 'Add quickstart guide' }],
          training_gaps: [],
          addie_improvements: [],
          escalation_patterns: [],
        },
        model_used: 'claude-sonnet',
        tokens_input: 5000,
        tokens_output: 2000,
        latency_ms: 3000,
        slack_channel_id: null,
        slack_message_ts: null,
        created_at: new Date(),
      };

      vi.mocked(createInsight).mockResolvedValue(mockRecord);

      // Mock working group lookup
      mockGetWorkingGroupBySlug.mockResolvedValue({
        slack_channel_id: 'C_EDITORIAL',
      });

      vi.mocked(sendChannelMessage).mockResolvedValue({ ok: true, ts: '123.456' });

      const result = await runConversationInsightsJob({ force: true });
      expect(result.generated).toBe(true);
      expect(result.posted).toBe(true);
      expect(createInsight).toHaveBeenCalled();
      expect(sendChannelMessage).toHaveBeenCalledWith('C_EDITORIAL', expect.objectContaining({ text: expect.stringContaining('Addie conversation insights') }));
      expect(markPosted).toHaveBeenCalledWith(1, 'C_EDITORIAL', '123.456');
    });

    it('handles race condition when another instance creates the insight', async () => {
      vi.mocked(getInsightByWeek).mockResolvedValue(null);
      vi.mocked(buildConversationInsights).mockResolvedValue({
        stats: { total_threads: 25, total_messages: 100, unique_users: 15, by_channel: {}, avg_rating: null, sentiment_breakdown: {}, outcome_breakdown: {}, escalation_count: 0, escalation_by_category: {} },
        analysis: { executive_summary: '', question_themes: [], documentation_gaps: [], training_gaps: [], addie_improvements: [], escalation_patterns: [] },
        model: 'claude-sonnet',
        tokensInput: 0,
        tokensOutput: 0,
        latencyMs: 0,
      });
      // ON CONFLICT returns null
      vi.mocked(createInsight).mockResolvedValue(null);

      const result = await runConversationInsightsJob({ force: true });
      expect(result.generated).toBe(false);
      expect(sendChannelMessage).not.toHaveBeenCalled();
    });
  });
});
