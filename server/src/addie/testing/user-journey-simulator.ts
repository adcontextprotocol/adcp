/**
 * User Journey Simulator
 *
 * Simulates realistic user journeys through the AgenticAdvertising.org ecosystem
 * for testing outreach effectiveness, action item triggers, and engagement patterns.
 *
 * Key testing goals:
 * 1. One-turn conversion - first outreach gets the desired action
 * 2. Action item accuracy - triggers fire at the right moments
 * 3. Red team scenarios - find edge cases and failure modes
 */

// User persona archetypes based on real ad tech roles
export interface UserPersona {
  id: string;
  name: string;
  role: 'publisher' | 'advertiser' | 'agency' | 'vendor' | 'developer' | 'executive';
  company: {
    name: string;
    type: 'publisher' | 'dsp' | 'ssp' | 'data_provider' | 'agency' | 'brand';
    size: 'startup' | 'mid_market' | 'enterprise';
    adtechMaturity: 'low' | 'medium' | 'high';
  };
  motivations: string[];
  painPoints: string[];
  skepticismLevel: 'low' | 'medium' | 'high';
  communicationStyle: 'brief' | 'detailed' | 'technical' | 'business';
  responseLatency: 'immediate' | 'same_day' | 'days' | 'never';
  likelyObjections: string[];
}

// Realistic personas based on ad tech industry
export const TEST_PERSONAS: UserPersona[] = [
  {
    id: 'sarah_publisher',
    name: 'Sarah Chen',
    role: 'publisher',
    company: {
      name: 'Digital Media Holdings',
      type: 'publisher',
      size: 'mid_market',
      adtechMaturity: 'high',
    },
    motivations: [
      'Reduce dependency on Google/Meta',
      'Find new programmatic partners',
      'Stay ahead of privacy changes',
    ],
    painPoints: [
      'Integration complexity with SSPs',
      'Low CPMs from programmatic',
      'Cookie deprecation uncertainty',
    ],
    skepticismLevel: 'medium',
    communicationStyle: 'business',
    responseLatency: 'same_day',
    likelyObjections: [
      'Another industry group?',
      'What makes this different from IAB?',
      'Do I have time for this?',
    ],
  },
  {
    id: 'marcus_dsp_engineer',
    name: 'Marcus Johnson',
    role: 'developer',
    company: {
      name: 'BidStream Technologies',
      type: 'dsp',
      size: 'startup',
      adtechMaturity: 'high',
    },
    motivations: [
      'Build AI-powered buying agents',
      'Learn about emerging protocols',
      'Network with other engineers',
    ],
    painPoints: [
      'No standard for AI agent communication',
      'Every SSP has different API',
      'Hard to get test inventory',
    ],
    skepticismLevel: 'low',
    communicationStyle: 'technical',
    responseLatency: 'immediate',
    likelyObjections: [
      'Is the spec production-ready?',
      'Who else is implementing this?',
    ],
  },
  {
    id: 'jennifer_agency_exec',
    name: 'Jennifer Martinez',
    role: 'executive',
    company: {
      name: 'Omnicom Media',
      type: 'agency',
      size: 'enterprise',
      adtechMaturity: 'high',
    },
    motivations: [
      'Client competitive advantage',
      'Industry thought leadership',
      'Early access to innovations',
    ],
    painPoints: [
      'Too many vendors, no standards',
      'Hard to compare platforms',
      'Lack of transparency in programmatic',
    ],
    skepticismLevel: 'high',
    communicationStyle: 'business',
    responseLatency: 'days',
    likelyObjections: [
      'What\'s the ROI of membership?',
      'Who else from our industry is involved?',
      'Can I send junior staff instead?',
    ],
  },
  {
    id: 'alex_brand_marketer',
    name: 'Alex Thompson',
    role: 'advertiser',
    company: {
      name: 'Consumer Brands Inc',
      type: 'brand',
      size: 'enterprise',
      adtechMaturity: 'low',
    },
    motivations: [
      'Understand ad tech better',
      'Reduce agency dependency',
      'Improve media transparency',
    ],
    painPoints: [
      'Don\'t understand programmatic',
      'Feel taken advantage of by vendors',
      'Can\'t verify what I\'m buying',
    ],
    skepticismLevel: 'high',
    communicationStyle: 'business',
    responseLatency: 'days',
    likelyObjections: [
      'Is this just for tech people?',
      'I don\'t code - is this for me?',
      'Will this help me with my actual job?',
    ],
  },
  {
    id: 'david_data_vendor',
    name: 'David Kim',
    role: 'vendor',
    company: {
      name: 'DataCo Analytics',
      type: 'data_provider',
      size: 'startup',
      adtechMaturity: 'medium',
    },
    motivations: [
      'Find integration partners',
      'Influence data standards',
      'Build distribution network',
    ],
    painPoints: [
      'Privacy regulations killing business',
      'Hard to integrate with DSPs/SSPs',
      'No standard data formats',
    ],
    skepticismLevel: 'medium',
    communicationStyle: 'detailed',
    responseLatency: 'same_day',
    likelyObjections: [
      'Will this help me sell more data?',
      'Is there a conflict with my competitors?',
    ],
  },
];

// Simulated activity patterns
export interface ActivityEvent {
  type: 'slack_message' | 'slack_reaction' | 'email_open' | 'email_click' |
        'dashboard_login' | 'addie_conversation' | 'working_group_join' |
        'event_register' | 'outreach_received' | 'outreach_response';
  timestamp: Date;
  channel?: string;
  content?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  metadata?: Record<string, unknown>;
}

export interface UserJourney {
  persona: UserPersona;
  startDate: Date;
  events: ActivityEvent[];
  currentState: {
    isLinked: boolean;
    isMember: boolean;
    engagementScore: number;
    excitementScore: number;
    lifecycleStage: 'new' | 'active' | 'engaged' | 'champion' | 'at_risk';
    outreachCount: number;
    lastOutreachResponse: 'none' | 'ignored' | 'responded' | 'converted';
  };
}

// Journey templates for different scenarios
export type JourneyScenario =
  | 'ideal_conversion'      // Quick signup, engaged immediately
  | 'slow_burner'          // Takes time but eventually converts
  | 'ghost'                // Never responds to anything
  | 'tire_kicker'          // Lots of activity, never converts
  | 'competitor_spy'       // Looking but not joining (competitor)
  | 'overwhelmed'          // Interested but too busy
  | 'skeptic_converted'    // Initially resistant, won over
  | 'churned_member'       // Was engaged, lost interest
  | 'enterprise_blocker'   // Needs org approval
  | 'technical_blocker';   // Wants to join but hitting issues

/**
 * Generate a realistic user journey based on persona and scenario
 */
export function generateJourney(
  persona: UserPersona,
  scenario: JourneyScenario,
  durationDays: number = 30
): UserJourney {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - durationDays);

  const events: ActivityEvent[] = [];
  const state: UserJourney['currentState'] = {
    isLinked: false,
    isMember: false,
    engagementScore: 0,
    excitementScore: 0,
    lifecycleStage: 'new',
    outreachCount: 0,
    lastOutreachResponse: 'none',
  };

  switch (scenario) {
    case 'ideal_conversion':
      events.push(...generateIdealConversionJourney(persona, startDate));
      state.isLinked = true;
      state.isMember = true;
      state.engagementScore = 75;
      state.excitementScore = 80;
      state.lifecycleStage = 'engaged';
      state.lastOutreachResponse = 'converted';
      break;

    case 'ghost':
      events.push(...generateGhostJourney(persona, startDate));
      state.outreachCount = 3;
      state.lastOutreachResponse = 'ignored';
      break;

    case 'tire_kicker':
      events.push(...generateTireKickerJourney(persona, startDate));
      state.engagementScore = 60;
      state.excitementScore = 30;
      state.lifecycleStage = 'active';
      state.outreachCount = 2;
      state.lastOutreachResponse = 'responded';
      break;

    case 'skeptic_converted':
      events.push(...generateSkepticJourney(persona, startDate));
      state.isLinked = true;
      state.isMember = true;
      state.engagementScore = 70;
      state.excitementScore = 65;
      state.lifecycleStage = 'engaged';
      state.outreachCount = 3;
      state.lastOutreachResponse = 'converted';
      break;

    case 'overwhelmed':
      events.push(...generateOverwhelmedJourney(persona, startDate));
      state.engagementScore = 25;
      state.excitementScore = 50;
      state.lifecycleStage = 'new';
      state.outreachCount = 2;
      state.lastOutreachResponse = 'responded';
      break;

    // Add more scenarios...
    default:
      events.push(...generateDefaultJourney(persona, startDate));
  }

  return {
    persona,
    startDate,
    events,
    currentState: state,
  };
}

// Journey generators for each scenario
function generateIdealConversionJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let day = 0;

  // Day 0: Joins Slack via invite
  events.push({
    type: 'slack_message',
    timestamp: addDays(start, day),
    channel: '#introductions',
    content: `Hi everyone! I'm ${persona.name} from ${persona.company.name}. Excited to be here!`,
    sentiment: 'positive',
  });

  // Day 1: Receives outreach
  day = 1;
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, day),
    content: 'Account link DM',
    metadata: { variant: 'direct_transparent' },
  });

  // Day 1: Responds immediately (ideal behavior)
  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, day, 2), // 2 hours later
    content: 'Thanks! Just linked my account.',
    sentiment: 'positive',
  });

  // Day 2: Explores dashboard
  day = 2;
  events.push({
    type: 'dashboard_login',
    timestamp: addDays(start, day),
  });

  // Day 3: Asks Addie a question
  day = 3;
  events.push({
    type: 'addie_conversation',
    timestamp: addDays(start, day),
    content: 'How do I join a working group?',
    sentiment: 'positive',
  });

  // Day 5: Joins working group
  day = 5;
  events.push({
    type: 'working_group_join',
    timestamp: addDays(start, day),
    metadata: { group: 'protocol-development' },
  });

  // Day 7+: Regular engagement
  for (let d = 7; d < 30; d += 3) {
    events.push({
      type: 'slack_message',
      timestamp: addDays(start, d),
      channel: '#protocol-development',
      content: 'Engaging in technical discussion...',
      sentiment: 'positive',
    });
  }

  return events;
}

function generateGhostJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Day 0: Added to Slack (passive)
  events.push({
    type: 'slack_message',
    timestamp: start,
    channel: '#introductions',
    content: '', // Empty - they never introduced themselves
    sentiment: 'neutral',
  });

  // Day 3: First outreach - ignored
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 3),
    metadata: { variant: 'direct_transparent' },
  });

  // Day 10: Second outreach - ignored
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 10),
    metadata: { variant: 'conversational' },
  });

  // Day 20: Third outreach - still ignored
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 20),
    metadata: { variant: 'brief_friendly' },
  });

  // Maybe one email open but no click
  events.push({
    type: 'email_open',
    timestamp: addDays(start, 5),
    metadata: { emailType: 'newsletter' },
  });

  return events;
}

function generateTireKickerJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Lots of activity - watching everything
  for (let d = 0; d < 30; d += 2) {
    events.push({
      type: 'slack_reaction',
      timestamp: addDays(start, d),
      channel: '#general',
      content: '👀', // Always watching
    });

    if (d % 6 === 0) {
      events.push({
        type: 'email_open',
        timestamp: addDays(start, d),
      });
    }
  }

  // Asks lots of questions
  events.push({
    type: 'addie_conversation',
    timestamp: addDays(start, 5),
    content: 'Who are your current members?',
  });

  events.push({
    type: 'addie_conversation',
    timestamp: addDays(start, 12),
    content: 'What does membership cost?',
  });

  events.push({
    type: 'addie_conversation',
    timestamp: addDays(start, 18),
    content: 'Are there any case studies?',
  });

  // Responds to outreach but doesn't convert
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 7),
  });

  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, 8),
    content: 'Interesting, I\'ll check it out!',
    sentiment: 'neutral',
  });

  return events;
}

function generateSkepticJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Day 0-7: Skeptical introduction
  events.push({
    type: 'slack_message',
    timestamp: start,
    channel: '#general',
    content: 'What exactly does this org do? Another standards body?',
    sentiment: 'negative',
  });

  // Day 3: First outreach - pushback
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 3),
  });

  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, 3, 4),
    content: 'Thanks but I\'m not sure this is relevant to me. How is this different from IAB?',
    sentiment: 'negative',
  });

  // Day 7: Sees something interesting
  events.push({
    type: 'slack_message',
    timestamp: addDays(start, 7),
    channel: '#protocol-development',
    content: 'Actually, this signals approach is interesting...',
    sentiment: 'neutral',
  });

  // Day 10: Asks Addie detailed questions
  events.push({
    type: 'addie_conversation',
    timestamp: addDays(start, 10),
    content: 'Can you explain how the media buy protocol handles real-time bidding?',
    sentiment: 'positive',
  });

  // Day 14: Second outreach - warming up
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 14),
  });

  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, 14, 1),
    content: 'I\'ve been looking at the protocol more. This is actually pretty cool.',
    sentiment: 'positive',
  });

  // Day 18: Converts
  events.push({
    type: 'dashboard_login',
    timestamp: addDays(start, 18),
    metadata: { action: 'account_link' },
  });

  // Day 20+: Active participation
  events.push({
    type: 'working_group_join',
    timestamp: addDays(start, 20),
    metadata: { group: 'signal-standards' },
  });

  return events;
}

function generateOverwhelmedJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Sporadic engagement
  events.push({
    type: 'slack_message',
    timestamp: start,
    channel: '#introductions',
    content: 'Hi all! Looking forward to learning more but super busy this quarter.',
    sentiment: 'positive',
  });

  // First outreach - positive but busy
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 3),
  });

  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, 5), // 2 days to respond
    content: 'Thanks for reaching out! I want to but swamped right now. Can you ping me next month?',
    sentiment: 'positive',
  });

  // Occasional lurking
  events.push({
    type: 'slack_reaction',
    timestamp: addDays(start, 10),
    content: '👍',
  });

  events.push({
    type: 'email_open',
    timestamp: addDays(start, 15),
  });

  // Second outreach - still busy
  events.push({
    type: 'outreach_received',
    timestamp: addDays(start, 20),
  });

  events.push({
    type: 'outreach_response',
    timestamp: addDays(start, 22),
    content: 'I know I said next month but things are still crazy. I\'ll reach out when I have bandwidth!',
    sentiment: 'neutral',
  });

  return events;
}

function generateDefaultJourney(persona: UserPersona, start: Date): ActivityEvent[] {
  return [
    {
      type: 'slack_message',
      timestamp: start,
      channel: '#introductions',
      content: `Hello from ${persona.company.name}`,
    },
  ];
}

// Helper to add days (and optional hours) to a date
function addDays(date: Date, days: number, hours: number = 0): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  result.setHours(result.getHours() + hours);
  return result;
}

/**
 * Analyze a journey to determine what action items should be created
 */
export interface JourneyAnalysis {
  journey: UserJourney;
  recommendedActions: {
    type: 'nudge' | 'warm_lead' | 'momentum' | 'alert' | 'celebration' | 'follow_up';
    reason: string;
    urgency: 'high' | 'medium' | 'low';
    suggestedMessage?: string;
  }[];
  conversionProbability: number;
  riskFactors: string[];
  opportunities: string[];
}

export function analyzeJourney(journey: UserJourney): JourneyAnalysis {
  const { persona, events, currentState } = journey;
  const recommendedActions: JourneyAnalysis['recommendedActions'] = [];
  const riskFactors: string[] = [];
  const opportunities: string[] = [];

  // Calculate days since various events
  const now = new Date();
  const outreachEvents = events.filter(e => e.type === 'outreach_received');
  const responseEvents = events.filter(e => e.type === 'outreach_response');
  const lastActivity = events[events.length - 1];

  const daysSinceLastOutreach = outreachEvents.length > 0
    ? Math.floor((now.getTime() - outreachEvents[outreachEvents.length - 1].timestamp.getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  const daysSinceLastActivity = lastActivity
    ? Math.floor((now.getTime() - lastActivity.timestamp.getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  // Count activity types
  const slackMessages = events.filter(e => e.type === 'slack_message').length;
  const addieConversations = events.filter(e => e.type === 'addie_conversation').length;
  const emailClicks = events.filter(e => e.type === 'email_click').length;

  // Analyze persona-specific factors
  if (persona.skepticismLevel === 'high') {
    riskFactors.push('High skepticism - needs proof points');
    if (responseEvents.some(e => e.sentiment === 'negative')) {
      recommendedActions.push({
        type: 'follow_up',
        reason: 'Skeptic showed resistance - needs targeted value prop',
        urgency: 'medium',
        suggestedMessage: `Given your role at ${persona.company.name}, you might find the ${persona.role === 'publisher' ? 'supply-side signal standards' : 'media buy protocol'} particularly relevant...`,
      });
    }
  }

  if (persona.responseLatency === 'never' || currentState.lastOutreachResponse === 'ignored') {
    if (currentState.outreachCount >= 3) {
      riskFactors.push('Multiple outreach attempts ignored - may be unengaged');
      recommendedActions.push({
        type: 'alert',
        reason: '3+ outreach attempts with no response',
        urgency: 'low',
      });
    } else if (slackMessages > 0 || emailClicks > 0) {
      // Activity but no response to DMs
      opportunities.push('Active in community but not responding to DMs');
      recommendedActions.push({
        type: 'momentum',
        reason: 'User is engaged in community but not responding to DMs',
        urgency: 'medium',
        suggestedMessage: `I noticed you've been active in ${events.find(e => e.channel)?.channel || 'the community'}. Happy to help if you have questions!`,
      });
    }
  }

  // Check for tire-kicker pattern
  const questionCount = addieConversations;
  if (questionCount >= 3 && !currentState.isLinked && !currentState.isMember) {
    riskFactors.push('Asking many questions but not converting - tire-kicker pattern');
    recommendedActions.push({
      type: 'warm_lead',
      reason: `${questionCount} Addie conversations but no account link`,
      urgency: 'medium',
      suggestedMessage: 'You\'ve been exploring the protocol - would it help to connect with someone who\'s already implementing it?',
    });
  }

  // Check for overwhelmed pattern
  const busyResponses = responseEvents.filter(e =>
    e.content?.toLowerCase().includes('busy') ||
    e.content?.toLowerCase().includes('next month') ||
    e.content?.toLowerCase().includes('later')
  );
  if (busyResponses.length > 0) {
    opportunities.push('Expressed interest but cited time constraints');
    recommendedActions.push({
      type: 'follow_up',
      reason: 'User mentioned being busy - schedule follow-up',
      urgency: 'low',
    });
  }

  // Check for conversion opportunity
  if (currentState.excitementScore > 60 && !currentState.isMember) {
    opportunities.push('High excitement score but not yet a member');
    recommendedActions.push({
      type: 'momentum',
      reason: 'High excitement - good time to push for conversion',
      urgency: 'high',
    });
  }

  // Calculate conversion probability
  let conversionProbability = 50; // Base

  // Positive factors
  if (persona.skepticismLevel === 'low') conversionProbability += 15;
  if (currentState.excitementScore > 50) conversionProbability += 10;
  if (addieConversations > 0) conversionProbability += 10;
  if (responseEvents.some(e => e.sentiment === 'positive')) conversionProbability += 15;
  if (persona.company.adtechMaturity === 'high') conversionProbability += 5;

  // Negative factors
  if (persona.skepticismLevel === 'high') conversionProbability -= 15;
  if (currentState.lastOutreachResponse === 'ignored') conversionProbability -= 20;
  if (daysSinceLastActivity > 14) conversionProbability -= 15;
  if (responseEvents.some(e => e.sentiment === 'negative')) conversionProbability -= 10;

  // Clamp to 0-100
  conversionProbability = Math.max(0, Math.min(100, conversionProbability));

  return {
    journey,
    recommendedActions,
    conversionProbability,
    riskFactors,
    opportunities,
  };
}

/**
 * RED TEAM: Scenarios designed to find failure modes
 */
export const RED_TEAM_SCENARIOS = {
  // Messages that should NOT be sent
  bad_timing: {
    name: 'Message sent at 2am on Sunday',
    scenario: 'User in different timezone, message sent during their night',
    expectedBehavior: 'System should respect timezone and business hours',
  },

  spam_risk: {
    name: 'Too many messages in short period',
    scenario: 'User gets 3 DMs in one week from bot',
    expectedBehavior: 'Rate limiting should prevent this',
  },

  wrong_tone: {
    name: 'Casual tone to enterprise executive',
    scenario: 'C-suite exec gets "Hey! Quick favor..."',
    expectedBehavior: 'Tone should match recipient seniority',
  },

  competitor_message: {
    name: 'Message to obvious competitor employee',
    scenario: 'Employee at competing org gets membership push',
    expectedBehavior: 'Should detect and handle differently',
  },

  // Messages that could backfire
  generic_followup: {
    name: 'Generic follow-up to specific complaint',
    scenario: 'User complained about something, gets template response',
    expectedBehavior: 'Should acknowledge specific feedback',
  },

  wrong_assumption: {
    name: 'Assumes wrong role/interest',
    scenario: 'Publisher gets DSP-focused messaging',
    expectedBehavior: 'Should personalize based on known info',
  },

  ignored_explicit_no: {
    name: 'Message after explicit decline',
    scenario: 'User said "not interested" but gets follow-up',
    expectedBehavior: 'Should respect explicit opt-out signals',
  },

  // Edge cases
  new_employee: {
    name: 'Message to very new Slack member',
    scenario: 'User joined Slack 5 minutes ago, gets DM',
    expectedBehavior: 'Should wait for natural engagement first',
  },

  returning_user: {
    name: 'Message to previously churned member',
    scenario: 'User who cancelled membership, now back in Slack',
    expectedBehavior: 'Should acknowledge history, not treat as new',
  },

  multiple_people_same_company: {
    name: 'Different messages to colleagues',
    scenario: 'Two people from same company get conflicting info',
    expectedBehavior: 'Should coordinate messaging within orgs',
  },
};

/**
 * Generate realistic response to an outreach message
 * Based on persona characteristics
 */
export function simulateResponse(
  persona: UserPersona,
  outreachMessage: string,
  variant: 'direct_transparent' | 'brief_friendly' | 'conversational'
): { responds: boolean; response?: string; sentiment: 'positive' | 'neutral' | 'negative' } {

  // Check if they would respond at all
  const responseChance = {
    immediate: 0.8,
    same_day: 0.6,
    days: 0.3,
    never: 0.05,
  }[persona.responseLatency];

  if (Math.random() > responseChance) {
    return { responds: false, sentiment: 'neutral' };
  }

  // Check tone match
  const toneMatch = (
    (persona.communicationStyle === 'brief' && variant === 'brief_friendly') ||
    (persona.communicationStyle === 'business' && variant === 'direct_transparent') ||
    (persona.communicationStyle === 'technical' && variant !== 'brief_friendly') ||
    (persona.communicationStyle === 'detailed' && variant === 'conversational')
  );

  // Generate response based on persona
  if (persona.skepticismLevel === 'high') {
    if (toneMatch) {
      return {
        responds: true,
        response: 'Thanks for reaching out. What exactly would I get from linking my account?',
        sentiment: 'neutral',
      };
    } else {
      return {
        responds: true,
        response: persona.likelyObjections[0],
        sentiment: 'negative',
      };
    }
  }

  if (persona.skepticismLevel === 'low' && toneMatch) {
    return {
      responds: true,
      response: 'Done! Just linked it. Thanks!',
      sentiment: 'positive',
    };
  }

  // Default neutral response
  return {
    responds: true,
    response: 'I\'ll take a look when I have a chance.',
    sentiment: 'neutral',
  };
}
