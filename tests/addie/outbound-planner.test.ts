/**
 * Tests for OutboundPlanner
 *
 * Focuses on the availability logic (isAvailable) for goals with deferred status.
 * Deferred goals with null next_attempt_at must be blocked indefinitely, not treated
 * as available.
 *
 * We test this through the public planNextAction() method with mocked DB dependencies.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { OutreachGoal, UserGoalHistory, PlannerContext } from '../../server/src/addie/types.js';

// Mock the database module before importing OutboundPlanner
const mockListGoals = jest.fn();
const mockListOutcomes = jest.fn();
const mockHasRelevantUpcomingEvents = jest.fn();

jest.mock('../../server/src/db/outbound-db.js', () => ({
  listGoals: mockListGoals,
  listOutcomes: mockListOutcomes,
  hasRelevantUpcomingEvents: mockHasRelevantUpcomingEvents,
}));

// Mock the logger to suppress output
jest.mock('../../server/src/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock the founding deadline to a fixed future date so time-sensitive rules are consistent
jest.mock('../../server/src/addie/founding-deadline.js', () => ({
  FOUNDING_DEADLINE: new Date('2099-01-01'),
}));

import { OutboundPlanner } from '../../server/src/addie/services/outbound-planner.js';

// Factory for a minimal OutreachGoal
function makeGoal(overrides: Partial<OutreachGoal> = {}): OutreachGoal {
  return {
    id: 1,
    name: 'Test Goal',
    category: 'information',
    description: null,
    success_insight_type: 'initial_interest',
    requires_mapped: false,
    requires_company_type: [],
    requires_persona: [],
    requires_min_engagement: 0,
    requires_insights: {},
    excludes_insights: {},
    base_priority: 50,
    message_template: 'Hello {{user_name}}!',
    follow_up_on_question: null,
    follow_up_template: null,
    max_attempts: 3,
    days_between_attempts: 7,
    is_enabled: true,
    created_by: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  };
}

// Factory for UserGoalHistory
function makeHistory(overrides: Partial<UserGoalHistory> = {}): UserGoalHistory {
  return {
    id: 1,
    slack_user_id: 'U123',
    goal_id: 1,
    status: 'sent',
    attempt_count: 1,
    last_attempt_at: null,
    next_attempt_at: null,
    outcome_id: null,
    response_text: null,
    response_sentiment: null,
    response_intent: null,
    planner_reason: null,
    planner_score: null,
    decision_method: null,
    outreach_id: null,
    thread_id: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  };
}

// Minimal PlannerContext that can contact the user
function makeContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    user: {
      slack_user_id: 'U123',
      display_name: 'Test User',
      is_mapped: true,
      is_member: false,
      engagement_score: 50,
      insights: [],
    },
    history: [],
    contact_eligibility: {
      can_contact: true,
      reason: 'eligible',
    },
    ...overrides,
  };
}

describe('OutboundPlanner', () => {
  let planner: OutboundPlanner;

  beforeEach(() => {
    jest.clearAllMocks();
    planner = new OutboundPlanner('test-api-key');
    // Default: no relevant events (prevents "Discover Events" goal from needing async check)
    mockHasRelevantUpcomingEvents.mockResolvedValue({ hasRelevantEvents: false, details: '', userLocation: null });
  });

  describe('isAvailable (tested via planNextAction)', () => {
    describe('deferred status', () => {
      it('blocks a deferred goal with null next_attempt_at', async () => {
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({
          goal_id: 1,
          status: 'deferred',
          next_attempt_at: null,
          last_attempt_at: null,
        });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });

      it('blocks a deferred goal when next_attempt_at is in the future', async () => {
        const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({
          goal_id: 1,
          status: 'deferred',
          next_attempt_at: futureDate,
          last_attempt_at: null,
        });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });

      it('makes a deferred goal available when next_attempt_at is in the past', async () => {
        const pastDate = new Date(Date.now() - 1000); // 1 second ago
        const goal = makeGoal({ id: 1, name: 'Link Account', category: 'admin' });
        const history = makeHistory({
          goal_id: 1,
          status: 'deferred',
          next_attempt_at: pastDate,
          last_attempt_at: null,
        });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).not.toBeNull();
        expect(result?.goal.id).toBe(1);
      });
    });

    describe('success status', () => {
      it('blocks a goal that was already successfully completed', async () => {
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({ goal_id: 1, status: 'success' });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });
    });

    describe('declined status', () => {
      it('blocks a goal the user declined', async () => {
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({ goal_id: 1, status: 'declined' });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });
    });

    describe('pending / sent status', () => {
      it('blocks a goal that is currently pending', async () => {
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({ goal_id: 1, status: 'pending' });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });

      it('blocks a goal that has been sent and is awaiting a response', async () => {
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({ goal_id: 1, status: 'sent' });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });
    });

    describe('cooldown after attempt', () => {
      it('blocks a goal attempted fewer than 7 days ago', async () => {
        const recentAttempt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
        const goal = makeGoal({ id: 1 });
        const history = makeHistory({
          goal_id: 1,
          status: 'responded',
          last_attempt_at: recentAttempt,
        });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).toBeNull();
      });

      it('makes a goal available when last attempt was more than 7 days ago', async () => {
        const oldAttempt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
        const goal = makeGoal({ id: 1, name: 'Link Account', category: 'admin' });
        const history = makeHistory({
          goal_id: 1,
          status: 'responded',
          last_attempt_at: oldAttempt,
        });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [history] })
        );

        expect(result).not.toBeNull();
        expect(result?.goal.id).toBe(1);
      });
    });

    describe('no history', () => {
      it('makes a goal available when there is no history for it', async () => {
        const goal = makeGoal({ id: 1, name: 'Link Account', category: 'admin' });

        mockListGoals.mockResolvedValue([goal]);

        const result = await planner.planNextAction(
          makeContext({ history: [] })
        );

        expect(result).not.toBeNull();
        expect(result?.goal.id).toBe(1);
      });

      it('returns null when there are no enabled goals', async () => {
        mockListGoals.mockResolvedValue([]);

        const result = await planner.planNextAction(makeContext());

        expect(result).toBeNull();
      });
    });
  });

  describe('contact eligibility', () => {
    it('returns null when user cannot be contacted', async () => {
      const goal = makeGoal({ id: 1 });
      mockListGoals.mockResolvedValue([goal]);

      const result = await planner.planNextAction(
        makeContext({
          contact_eligibility: {
            can_contact: false,
            reason: 'opted_out',
          },
        })
      );

      expect(result).toBeNull();
      // Should not even query the database
      expect(mockListGoals).not.toHaveBeenCalled();
    });
  });

  describe('deferred regression: null next_attempt_at was previously treated as available', () => {
    it('does not select a goal that is deferred with no retry time, even when other logic would permit it', async () => {
      // This test captures the pre-fix behavior where a deferred goal with
      // null next_attempt_at fell through the deferred check and remained eligible
      // (because the old condition was: `if (h.status === 'deferred' && h.next_attempt_at)`)
      // Post-fix: deferred + null next_attempt_at = blocked indefinitely.
      const deferredGoal = makeGoal({ id: 1, name: 'Link Account', category: 'admin', base_priority: 80 });
      const otherGoal = makeGoal({ id: 2, name: 'Some Other Goal', category: 'information', base_priority: 50 });

      const deferredHistory = makeHistory({
        goal_id: 1,
        status: 'deferred',
        next_attempt_at: null,
        last_attempt_at: null,
      });

      mockListGoals.mockResolvedValue([deferredGoal, otherGoal]);

      const result = await planner.planNextAction(
        makeContext({ history: [deferredHistory] })
      );

      // The deferred goal must NOT be selected
      expect(result?.goal.id).not.toBe(1);
      // The other goal should be selected instead
      expect(result?.goal.id).toBe(2);
    });
  });
});
