/**
 * Synthetic person profiles for simulation testing.
 *
 * Each represents a distinct archetype that stresses different parts
 * of Addie's engagement system.
 */

import type { SimPersonProfile } from '../../engine/types.js';

// ---------------------------------------------------------------------------
// 1. Cold email prospect — email only, never contacted
// ---------------------------------------------------------------------------
export const coldEmailProspect: SimPersonProfile = {
  id: 'cold-email-prospect',
  description: 'Email-only prospect, never contacted, has org data',
  relationship: {
    email: 'alex@meridianmedia.example',
    prospect_org_id: 'org_sim_meridian',
    display_name: 'Alex Chen',
    stage: 'prospect',
  },
  organization: {
    name: 'Meridian Media Group',
    workos_organization_id: 'org_sim_meridian',
    domain: 'meridianmedia.example',
    company_type: 'agency',
    persona: 'media_buyer',
    prospect_contact_email: 'alex@meridianmedia.example',
    prospect_contact_name: 'Alex Chen',
    prospect_owner: 'addie',
  },
};

// ---------------------------------------------------------------------------
// 2. Slack-only new joiner — just joined, no history
// ---------------------------------------------------------------------------
export const slackNewJoiner: SimPersonProfile = {
  id: 'slack-new-joiner',
  description: 'Just joined Slack, no account link, no message history',
  relationship: {
    slack_user_id: 'SIM_U_NEW01',
    display_name: 'Jordan Rivera',
    stage: 'prospect',
  },
};

// ---------------------------------------------------------------------------
// 3. Welcomed but silent — got welcome 5 days ago, never responded
// ---------------------------------------------------------------------------
export const welcomedSilent: SimPersonProfile = {
  id: 'welcomed-silent',
  description: 'Welcomed 5 days ago, never responded, 1 unreplied message',
  relationship: {
    slack_user_id: 'SIM_U_SILENT01',
    display_name: 'Casey Morgan',
    stage: 'welcomed',
    last_addie_message_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    unreplied_outreach_count: 1,
    interaction_count: 1,
  },
  messageHistory: [
    {
      role: 'assistant',
      content: 'Hi Casey! Welcome to AgenticAdvertising.org. I noticed you joined our Slack recently. What brings you to the community?',
      channel: 'slack',
      relativeTime: { days: -5 },
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. Exploring multi-surface — has Slack + web messages, linked account
// ---------------------------------------------------------------------------
export const exploringMultiSurface: SimPersonProfile = {
  id: 'exploring-multi-surface',
  description: 'Linked account, messages on both Slack and web, exploring stage',
  relationship: {
    slack_user_id: 'SIM_U_EXPLORE01',
    workos_user_id: 'sim_workos_explore01',
    email: 'pat@novabrands.example',
    display_name: 'Pat Nakamura',
    stage: 'exploring',
    last_addie_message_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    last_person_message_at: new Date(Date.now() - 8 * 86400000).toISOString(),
    interaction_count: 5,
    unreplied_outreach_count: 0,
  },
  messageHistory: [
    {
      role: 'assistant',
      content: 'Welcome to AgenticAdvertising.org, Pat! Great to have you here.',
      channel: 'slack',
      relativeTime: { days: -15 },
    },
    {
      role: 'user',
      content: 'Thanks! We are building programmatic CTV measurement tools and looking to connect with others in the space.',
      channel: 'slack',
      relativeTime: { days: -14 },
    },
    {
      role: 'assistant',
      content: 'That sounds fascinating. The Measurement working group might be right up your alley.',
      channel: 'slack',
      relativeTime: { days: -10 },
    },
    {
      role: 'user',
      content: 'Can you tell me more about how working groups operate?',
      channel: 'web',
      relativeTime: { days: -8 },
    },
  ],
  insights: [
    { type: 'initial_interest', value: 'CTV measurement', confidence: 'high' },
    { type: 'company_focus', value: 'programmatic advertising', confidence: 'medium' },
  ],
};

// ---------------------------------------------------------------------------
// 5. Active going quiet — was contributing, no messages in 20 days
// ---------------------------------------------------------------------------
export const activeGoingQuiet: SimPersonProfile = {
  id: 'active-going-quiet',
  description: 'Was contributing (20+ messages/month), went silent 20 days ago',
  relationship: {
    slack_user_id: 'SIM_U_QUIET01',
    workos_user_id: 'sim_workos_quiet01',
    email: 'sam@pinnacletech.example',
    display_name: 'Sam Okafor',
    stage: 'contributing',
    sentiment_trend: 'disengaging',
    last_addie_message_at: new Date(Date.now() - 35 * 86400000).toISOString(),
    last_person_message_at: new Date(Date.now() - 20 * 86400000).toISOString(),
    interaction_count: 45,
    unreplied_outreach_count: 0,
  },
  messageHistory: [
    {
      role: 'user',
      content: 'The measurement spec draft looks good. I left some comments on the PR.',
      channel: 'slack',
      relativeTime: { days: -20 },
    },
    {
      role: 'assistant',
      content: 'Thanks Sam, the team really values your input on the measurement spec.',
      channel: 'slack',
      relativeTime: { days: -20, hours: 1 },
    },
  ],
  insights: [
    { type: 'expertise', value: 'measurement and attribution', confidence: 'high' },
    { type: 'role', value: 'engineering lead', confidence: 'high' },
  ],
};

// ---------------------------------------------------------------------------
// 6. Leader who asks Addie questions
// ---------------------------------------------------------------------------
export const leaderAsksQuestions: SimPersonProfile = {
  id: 'leader-asks-questions',
  description: 'Committee leader, high engagement, asks Addie for help',
  relationship: {
    slack_user_id: 'SIM_U_LEADER01',
    workos_user_id: 'sim_workos_leader01',
    email: 'taylor@acmeadtech.example',
    display_name: 'Taylor Brooks',
    stage: 'leading',
    last_addie_message_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    last_person_message_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    interaction_count: 120,
    unreplied_outreach_count: 0,
  },
  messageHistory: [
    {
      role: 'user',
      content: 'Hey Addie, can you help me draft an agenda for next week\'s measurement council meeting?',
      channel: 'slack',
      relativeTime: { days: -1 },
    },
    {
      role: 'assistant',
      content: 'Of course, Taylor! Let me help with the agenda. What topics are top priority this week?',
      channel: 'slack',
      relativeTime: { days: -1, hours: 1 },
    },
  ],
};

// ---------------------------------------------------------------------------
// 7. Opted-out person
// ---------------------------------------------------------------------------
export const optedOut: SimPersonProfile = {
  id: 'opted-out',
  description: 'Previously active, opted out of all outreach',
  relationship: {
    slack_user_id: 'SIM_U_OPTOUT01',
    display_name: 'Morgan Wells',
    stage: 'exploring',
    opted_out: true,
    last_addie_message_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    interaction_count: 8,
  },
};

// ---------------------------------------------------------------------------
// 8. Email-preference person — has Slack but prefers email
// ---------------------------------------------------------------------------
export const emailPreference: SimPersonProfile = {
  id: 'email-preference',
  description: 'Has Slack account but contact_preference set to email',
  relationship: {
    slack_user_id: 'SIM_U_EMAILPREF01',
    email: 'riley@spectrumads.example',
    display_name: 'Riley Patel',
    stage: 'welcomed',
    contact_preference: 'email',
    last_addie_message_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    last_person_message_at: new Date(Date.now() - 9 * 86400000).toISOString(),
    interaction_count: 3,
    unreplied_outreach_count: 0,
  },
};

// ---------------------------------------------------------------------------
// 9. Identity merge — email prospect who then joins Slack
// ---------------------------------------------------------------------------
export const identityMerge: SimPersonProfile = {
  id: 'identity-merge',
  description: 'Email-only prospect, will later join Slack (tests identity merge)',
  relationship: {
    email: 'drew@horizondigital.example',
    prospect_org_id: 'org_sim_horizon',
    display_name: 'Drew Martinez',
    stage: 'prospect',
  },
  organization: {
    name: 'Horizon Digital',
    workos_organization_id: 'org_sim_horizon',
    domain: 'horizondigital.example',
    company_type: 'brand',
    prospect_contact_email: 'drew@horizondigital.example',
    prospect_contact_name: 'Drew Martinez',
    prospect_owner: 'addie',
  },
};

// ---------------------------------------------------------------------------
// 10. Annoyance cascade test — welcomed, multiple unreplied
// ---------------------------------------------------------------------------
export const annoyanceCascade: SimPersonProfile = {
  id: 'annoyance-cascade',
  description: 'Welcomed with 2 unreplied messages, tests backoff behavior',
  relationship: {
    slack_user_id: 'SIM_U_ANNOY01',
    display_name: 'Avery Kim',
    stage: 'welcomed',
    last_addie_message_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    unreplied_outreach_count: 2,
    interaction_count: 2,
  },
  messageHistory: [
    {
      role: 'assistant',
      content: 'Hi Avery! Welcome to AgenticAdvertising.org.',
      channel: 'slack',
      relativeTime: { days: -8 },
    },
    {
      role: 'assistant',
      content: 'Just checking in — would love to help you get started.',
      channel: 'slack',
      relativeTime: { days: -4 },
    },
  ],
};

// ---------------------------------------------------------------------------
// All profiles
// ---------------------------------------------------------------------------

export const ALL_PROFILES: SimPersonProfile[] = [
  coldEmailProspect,
  slackNewJoiner,
  welcomedSilent,
  exploringMultiSurface,
  activeGoingQuiet,
  leaderAsksQuestions,
  optedOut,
  emailPreference,
  identityMerge,
  annoyanceCascade,
];
