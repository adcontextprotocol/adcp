/**
 * Action Trigger Testing System
 *
 * Tests the action item creation logic against simulated user scenarios.
 * Validates that:
 * 1. Action items fire at the right time (not too early, not too late)
 * 2. The right type of action is created for each scenario
 * 3. Rate limiting and business rules are respected
 * 4. Edge cases are handled correctly
 */

import {
  UserPersona,
  UserJourney,
  ActivityEvent,
  TEST_PERSONAS,
  generateJourney,
  analyzeJourney,
  JourneyScenario,
} from './user-journey-simulator.js';

// Action trigger configuration (mirrors momentum-check.ts)
const ACTION_TRIGGER_CONFIG = {
  NUDGE_DAYS: 3,
  WARM_LEAD_DAYS: 7,
  MOMENTUM_THRESHOLD: 3,
  RATE_LIMIT_DAYS: 7,
  GRACE_PERIOD_HOURS: 24, // Don't message new users immediately
  BUSINESS_HOURS_START: 9,
  BUSINESS_HOURS_END: 17,
  BUSINESS_DAYS: [1, 2, 3, 4, 5], // Monday-Friday
};

interface ActionTriggerTestCase {
  id: string;
  name: string;
  description: string;
  setup: () => SimulatedUserState;
  expectedAction: ExpectedAction | null;
  validate: (state: SimulatedUserState, action: TriggeredAction | null) => ValidationResult;
}

interface SimulatedUserState {
  userId: string;
  persona: UserPersona;
  events: ActivityEvent[];
  outreachHistory: OutreachRecord[];
  currentStatus: {
    isLinked: boolean;
    isMember: boolean;
    daysSinceJoined: number;
    daysSinceLastActivity: number;
    daysSinceLastOutreach: number | null;
    totalActivityCount: number;
  };
  existingActionItems: SimulatedActionItem[];
}

interface OutreachRecord {
  id: string;
  type: 'account_link' | 'nudge' | 'follow_up';
  variant: string;
  sentAt: Date;
  responded: boolean;
  response?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
}

interface SimulatedActionItem {
  id: string;
  type: 'nudge' | 'warm_lead' | 'momentum' | 'feedback' | 'alert' | 'follow_up' | 'celebration';
  status: 'open' | 'snoozed' | 'completed' | 'dismissed';
  createdAt: Date;
  triggerId?: string;
}

interface ExpectedAction {
  type: 'nudge' | 'warm_lead' | 'momentum' | 'alert' | 'celebration' | 'follow_up' | 'none';
  priority?: 'high' | 'medium' | 'low';
  reason: string;
}

interface TriggeredAction {
  type: string;
  priority: string;
  title: string;
  description: string;
  reason: string;
}

interface ValidationResult {
  passed: boolean;
  expected: string;
  actual: string;
  issues: string[];
}

// Simulate what the momentum check would do
function simulateMomentumCheck(state: SimulatedUserState): TriggeredAction | null {
  const { currentStatus, outreachHistory, existingActionItems, events } = state;

  // Check if there's already an open action item for this user
  const hasOpenActionItem = existingActionItems.some(ai => ai.status === 'open');
  if (hasOpenActionItem) {
    return null; // Don't create duplicate
  }

  // Check if user is too new (grace period)
  if (currentStatus.daysSinceJoined < 1) {
    return null; // Grace period
  }

  // No outreach history - nothing to analyze
  if (outreachHistory.length === 0) {
    return null;
  }

  const lastOutreach = outreachHistory[outreachHistory.length - 1];
  const daysSince = currentStatus.daysSinceLastOutreach || 0;

  // Count activity since last outreach
  const lastOutreachDate = lastOutreach.sentAt;
  const activitySinceOutreach = events.filter(
    e => e.timestamp > lastOutreachDate
  ).length;

  // Success case: user converted
  if (lastOutreach.type === 'account_link' && currentStatus.isLinked) {
    if (lastOutreach.responded) {
      return {
        type: 'celebration',
        priority: 'low',
        title: 'Account linked after outreach!',
        description: 'User successfully linked their account.',
        reason: 'Conversion success - responded and linked',
      };
    }
  }

  // User responded but didn't convert yet
  if (lastOutreach.responded && !currentStatus.isLinked) {
    return {
      type: 'warm_lead',
      priority: 'medium',
      title: 'Responded but didn\'t link account',
      description: `User responded ${daysSince} days ago but hasn't linked yet.`,
      reason: 'Responded to outreach without conversion',
    };
  }

  // Lots of activity but no direct response - momentum opportunity
  if (!lastOutreach.responded && activitySinceOutreach >= ACTION_TRIGGER_CONFIG.MOMENTUM_THRESHOLD) {
    return {
      type: 'momentum',
      priority: 'low',
      title: 'Active user, good time to engage',
      description: `No response but ${activitySinceOutreach} activities since outreach.`,
      reason: 'High activity without direct response',
    };
  }

  // Some activity but no response - warm lead
  if (!lastOutreach.responded && activitySinceOutreach > 0 && activitySinceOutreach < ACTION_TRIGGER_CONFIG.MOMENTUM_THRESHOLD) {
    return {
      type: 'warm_lead',
      priority: 'medium',
      title: 'Some activity, might need a nudge',
      description: `${activitySinceOutreach} activities but no direct response.`,
      reason: 'Some activity without direct response',
    };
  }

  // No activity - needs nudge (but only after threshold)
  if (!lastOutreach.responded && activitySinceOutreach === 0 && daysSince >= ACTION_TRIGGER_CONFIG.NUDGE_DAYS) {
    return {
      type: 'nudge',
      priority: 'medium',
      title: `No response after ${daysSince} days`,
      description: 'Zero activity since outreach - consider follow-up.',
      reason: 'No activity after nudge threshold',
    };
  }

  return null; // Too early or no action needed
}

// Test cases
export const ACTION_TRIGGER_TESTS: ActionTriggerTestCase[] = [
  {
    id: 'new_user_grace_period',
    name: 'New User Grace Period',
    description: 'User who just joined should not receive outreach immediately',
    setup: () => ({
      userId: 'test_new_user',
      persona: TEST_PERSONAS[0],
      events: [],
      outreachHistory: [],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 0, // Just joined
        daysSinceLastActivity: 0,
        daysSinceLastOutreach: null,
        totalActivityCount: 0,
      },
      existingActionItems: [],
    }),
    expectedAction: null,
    validate: (state, action) => {
      const passed = action === null;
      return {
        passed,
        expected: 'No action (grace period)',
        actual: action ? `Created ${action.type}` : 'No action',
        issues: passed ? [] : ['Grace period not respected - new users should not be messaged immediately'],
      };
    },
  },

  {
    id: 'successful_conversion',
    name: 'Successful Conversion Celebration',
    description: 'User who responded and linked should get celebration',
    setup: () => ({
      userId: 'test_converted',
      persona: TEST_PERSONAS[1],
      events: [
        { type: 'slack_message', timestamp: daysAgo(3), channel: '#general', content: 'Hello!' },
        { type: 'outreach_response', timestamp: daysAgo(2), content: 'Done, linked!' },
        { type: 'dashboard_login', timestamp: daysAgo(1) },
      ],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'direct_transparent',
        sentAt: daysAgo(3),
        responded: true,
        response: 'Done, linked!',
        sentiment: 'positive',
      }],
      currentStatus: {
        isLinked: true,
        isMember: false,
        daysSinceJoined: 7,
        daysSinceLastActivity: 1,
        daysSinceLastOutreach: 3,
        totalActivityCount: 3,
      },
      existingActionItems: [],
    }),
    expectedAction: { type: 'celebration', reason: 'User converted after outreach' },
    validate: (state, action) => {
      const passed = action?.type === 'celebration';
      return {
        passed,
        expected: 'celebration',
        actual: action?.type || 'none',
        issues: passed ? [] : ['Conversion should trigger celebration action item'],
      };
    },
  },

  {
    id: 'no_response_too_early',
    name: 'No Response Too Early',
    description: 'Should not create nudge before threshold days',
    setup: () => ({
      userId: 'test_too_early',
      persona: TEST_PERSONAS[0],
      events: [],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'direct_transparent',
        sentAt: daysAgo(1), // Only 1 day ago
        responded: false,
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 10,
        daysSinceLastActivity: 1,
        daysSinceLastOutreach: 1,
        totalActivityCount: 0,
      },
      existingActionItems: [],
    }),
    expectedAction: null,
    validate: (state, action) => {
      const passed = action === null;
      return {
        passed,
        expected: 'No action (too early for nudge)',
        actual: action ? `Created ${action.type}` : 'No action',
        issues: passed ? [] : [`Nudge created after only ${state.currentStatus.daysSinceLastOutreach} days (threshold is ${ACTION_TRIGGER_CONFIG.NUDGE_DAYS})`],
      };
    },
  },

  {
    id: 'no_response_nudge_time',
    name: 'No Response - Nudge Time',
    description: 'Should create nudge after threshold days with no activity',
    setup: () => ({
      userId: 'test_nudge',
      persona: TEST_PERSONAS[0],
      events: [],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'direct_transparent',
        sentAt: daysAgo(4), // Past threshold
        responded: false,
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 14,
        daysSinceLastActivity: 4,
        daysSinceLastOutreach: 4,
        totalActivityCount: 0,
      },
      existingActionItems: [],
    }),
    expectedAction: { type: 'nudge', reason: 'No activity after threshold' },
    validate: (state, action) => {
      const passed = action?.type === 'nudge';
      return {
        passed,
        expected: 'nudge',
        actual: action?.type || 'none',
        issues: passed ? [] : ['Nudge should be created after 3+ days with no activity'],
      };
    },
  },

  {
    id: 'active_but_no_response_momentum',
    name: 'Active But No Response - Momentum',
    description: 'User is active but hasn\'t responded directly - momentum opportunity',
    setup: () => ({
      userId: 'test_momentum',
      persona: TEST_PERSONAS[1],
      events: [
        { type: 'slack_message', timestamp: daysAgo(2), channel: '#general', content: 'Interesting!' },
        { type: 'slack_reaction', timestamp: daysAgo(2), content: '👀' },
        { type: 'email_open', timestamp: daysAgo(1) },
        { type: 'addie_conversation', timestamp: daysAgo(1), content: 'How does this work?' },
      ],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'conversational',
        sentAt: daysAgo(3),
        responded: false,
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 10,
        daysSinceLastActivity: 1,
        daysSinceLastOutreach: 3,
        totalActivityCount: 4,
      },
      existingActionItems: [],
    }),
    expectedAction: { type: 'momentum', reason: 'High activity without direct response' },
    validate: (state, action) => {
      const passed = action?.type === 'momentum';
      return {
        passed,
        expected: 'momentum',
        actual: action?.type || 'none',
        issues: passed ? [] : ['Active users without direct response should trigger momentum opportunity'],
      };
    },
  },

  {
    id: 'responded_not_converted',
    name: 'Responded But Not Converted',
    description: 'User responded positively but hasn\'t linked - warm lead',
    setup: () => ({
      userId: 'test_warm',
      persona: TEST_PERSONAS[2],
      events: [
        { type: 'outreach_response', timestamp: daysAgo(2), content: 'Looks interesting!', sentiment: 'positive' },
      ],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'direct_transparent',
        sentAt: daysAgo(3),
        responded: true,
        response: 'Looks interesting!',
        sentiment: 'positive',
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 14,
        daysSinceLastActivity: 2,
        daysSinceLastOutreach: 3,
        totalActivityCount: 1,
      },
      existingActionItems: [],
    }),
    expectedAction: { type: 'warm_lead', reason: 'Responded without conversion' },
    validate: (state, action) => {
      const passed = action?.type === 'warm_lead';
      return {
        passed,
        expected: 'warm_lead',
        actual: action?.type || 'none',
        issues: passed ? [] : ['User who responded but didn\'t convert should be a warm lead'],
      };
    },
  },

  {
    id: 'existing_action_item_no_duplicate',
    name: 'No Duplicate Action Items',
    description: 'Should not create action if one already exists',
    setup: () => ({
      userId: 'test_no_duplicate',
      persona: TEST_PERSONAS[0],
      events: [],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'direct_transparent',
        sentAt: daysAgo(5),
        responded: false,
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 14,
        daysSinceLastActivity: 5,
        daysSinceLastOutreach: 5,
        totalActivityCount: 0,
      },
      existingActionItems: [{
        id: 'existing_1',
        type: 'nudge',
        status: 'open',
        createdAt: daysAgo(2),
        triggerId: 'outreach_1',
      }],
    }),
    expectedAction: null,
    validate: (state, action) => {
      const passed = action === null;
      return {
        passed,
        expected: 'No action (duplicate prevention)',
        actual: action ? `Created ${action.type}` : 'No action',
        issues: passed ? [] : ['Duplicate action item created when one already exists'],
      };
    },
  },

  {
    id: 'some_activity_warm_lead',
    name: 'Some Activity - Warm Lead',
    description: 'User has some activity but below momentum threshold',
    setup: () => ({
      userId: 'test_some_activity',
      persona: TEST_PERSONAS[0],
      events: [
        { type: 'slack_reaction', timestamp: daysAgo(1), content: '👍' },
        { type: 'email_open', timestamp: daysAgo(2) },
      ],
      outreachHistory: [{
        id: 'outreach_1',
        type: 'account_link',
        variant: 'brief_friendly',
        sentAt: daysAgo(4),
        responded: false,
      }],
      currentStatus: {
        isLinked: false,
        isMember: false,
        daysSinceJoined: 10,
        daysSinceLastActivity: 1,
        daysSinceLastOutreach: 4,
        totalActivityCount: 2,
      },
      existingActionItems: [],
    }),
    expectedAction: { type: 'warm_lead', reason: 'Some activity below momentum threshold' },
    validate: (state, action) => {
      const passed = action?.type === 'warm_lead';
      return {
        passed,
        expected: 'warm_lead',
        actual: action?.type || 'none',
        issues: passed ? [] : ['Users with some activity should be warm leads'],
      };
    },
  },
];

// Helper function
function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

// Run all action trigger tests
export function runActionTriggerTests(): {
  total: number;
  passed: number;
  failed: number;
  results: {
    test: ActionTriggerTestCase;
    state: SimulatedUserState;
    action: TriggeredAction | null;
    validation: ValidationResult;
  }[];
  criticalFailures: string[];
} {
  const results = ACTION_TRIGGER_TESTS.map(test => {
    const state = test.setup();
    const action = simulateMomentumCheck(state);
    const validation = test.validate(state, action);

    return {
      test,
      state,
      action,
      validation,
    };
  });

  const passed = results.filter(r => r.validation.passed).length;
  const failed = results.filter(r => !r.validation.passed).length;

  // Identify critical failures (tests that could cause user frustration)
  const criticalTestIds = ['new_user_grace_period', 'existing_action_item_no_duplicate', 'no_response_too_early'];
  const criticalFailures = results
    .filter(r => criticalTestIds.includes(r.test.id) && !r.validation.passed)
    .map(r => `CRITICAL: ${r.test.name} - ${r.validation.issues.join(', ')}`);

  return {
    total: results.length,
    passed,
    failed,
    results,
    criticalFailures,
  };
}

// Generate comprehensive test report
export function generateActionTriggerReport(): string {
  const { total, passed, failed, results, criticalFailures } = runActionTriggerTests();

  let report = '# Action Trigger Test Report\n\n';
  report += `## Summary\n`;
  report += `- Total Tests: ${total}\n`;
  report += `- Passed: ${passed}\n`;
  report += `- Failed: ${failed}\n`;
  report += `- Pass Rate: ${Math.round((passed / total) * 100)}%\n\n`;

  if (criticalFailures.length > 0) {
    report += `## ⚠️ Critical Failures\n`;
    criticalFailures.forEach(f => {
      report += `- ${f}\n`;
    });
    report += '\n';
  }

  report += `## Test Results\n\n`;

  results.forEach(({ test, action, validation }) => {
    const status = validation.passed ? '✅' : '❌';
    report += `### ${status} ${test.name}\n`;
    report += `**ID:** ${test.id}\n`;
    report += `**Description:** ${test.description}\n`;
    report += `**Expected:** ${validation.expected}\n`;
    report += `**Actual:** ${validation.actual}\n`;

    if (!validation.passed) {
      report += `**Issues:**\n`;
      validation.issues.forEach(issue => {
        report += `  - ${issue}\n`;
      });
    }
    report += '\n';
  });

  report += `## Configuration\n`;
  report += `- Nudge Days: ${ACTION_TRIGGER_CONFIG.NUDGE_DAYS}\n`;
  report += `- Warm Lead Days: ${ACTION_TRIGGER_CONFIG.WARM_LEAD_DAYS}\n`;
  report += `- Momentum Threshold: ${ACTION_TRIGGER_CONFIG.MOMENTUM_THRESHOLD}\n`;
  report += `- Rate Limit Days: ${ACTION_TRIGGER_CONFIG.RATE_LIMIT_DAYS}\n`;
  report += `- Grace Period Hours: ${ACTION_TRIGGER_CONFIG.GRACE_PERIOD_HOURS}\n`;

  return report;
}

// Test action triggers against user journey scenarios
export function testActionTriggersForJourney(
  journey: UserJourney
): {
  journey: UserJourney;
  analysis: ReturnType<typeof analyzeJourney>;
  simulatedActions: TriggeredAction[];
  gaps: string[];
  recommendations: string[];
} {
  const analysis = analyzeJourney(journey);

  // Convert journey to simulated state at different points
  const simulatedActions: TriggeredAction[] = [];
  const gaps: string[] = [];

  // Check what actions the momentum system would create
  const outreachEvents = journey.events.filter(e => e.type === 'outreach_received');

  outreachEvents.forEach((outreach, idx) => {
    const outreachDate = outreach.timestamp;
    const responseEvent = journey.events.find(
      e => e.type === 'outreach_response' && e.timestamp > outreachDate
    );

    const activitySince = journey.events.filter(
      e => e.timestamp > outreachDate && e.type !== 'outreach_received'
    ).length;

    const state: SimulatedUserState = {
      userId: journey.persona.id,
      persona: journey.persona,
      events: journey.events.filter(e => e.timestamp > outreachDate),
      outreachHistory: [{
        id: `outreach_${idx}`,
        type: 'account_link',
        variant: (outreach.metadata?.variant as string) || 'direct_transparent',
        sentAt: outreachDate,
        responded: !!responseEvent,
        response: responseEvent?.content,
        sentiment: responseEvent?.sentiment,
      }],
      currentStatus: {
        isLinked: journey.currentState.isLinked,
        isMember: journey.currentState.isMember,
        daysSinceJoined: Math.floor((Date.now() - journey.startDate.getTime()) / (1000 * 60 * 60 * 24)),
        daysSinceLastActivity: 0,
        daysSinceLastOutreach: Math.floor((Date.now() - outreachDate.getTime()) / (1000 * 60 * 60 * 24)),
        totalActivityCount: activitySince,
      },
      existingActionItems: [],
    };

    const action = simulateMomentumCheck(state);
    if (action) {
      simulatedActions.push(action);
    }
  });

  // Compare with journey analysis recommendations
  analysis.recommendedActions.forEach(rec => {
    const hasMatchingAction = simulatedActions.some(a => a.type === rec.type);
    if (!hasMatchingAction) {
      gaps.push(`Analysis recommends "${rec.type}" (${rec.reason}) but momentum check wouldn't create it`);
    }
  });

  // Generate recommendations based on gaps
  const recommendations: string[] = [];
  if (gaps.length > 0) {
    recommendations.push('Consider expanding momentum check triggers to catch:');
    gaps.forEach(gap => recommendations.push(`  - ${gap}`));
  }

  // Check for over-triggering
  if (simulatedActions.length > analysis.recommendedActions.length) {
    recommendations.push('Momentum check may be over-triggering - created more actions than journey analysis recommends');
  }

  return {
    journey,
    analysis,
    simulatedActions,
    gaps,
    recommendations,
  };
}

// Run journey-based tests for all scenarios
export function runJourneyActionTests(): {
  scenarios: JourneyScenario[];
  results: ReturnType<typeof testActionTriggersForJourney>[];
  overallGaps: string[];
  overallRecommendations: string[];
} {
  const scenarios: JourneyScenario[] = [
    'ideal_conversion',
    'ghost',
    'tire_kicker',
    'skeptic_converted',
    'overwhelmed',
  ];

  const results = TEST_PERSONAS.flatMap(persona =>
    scenarios.map(scenario => {
      const journey = generateJourney(persona, scenario);
      return testActionTriggersForJourney(journey);
    })
  );

  // Aggregate gaps and recommendations
  const allGaps = new Set<string>();
  const allRecs = new Set<string>();

  results.forEach(r => {
    r.gaps.forEach(g => allGaps.add(g));
    r.recommendations.forEach(rec => allRecs.add(rec));
  });

  return {
    scenarios,
    results,
    overallGaps: Array.from(allGaps),
    overallRecommendations: Array.from(allRecs),
  };
}
