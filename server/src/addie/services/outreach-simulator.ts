/**
 * Outreach Simulator
 *
 * Tests the engagement planner against synthetic personas to predict behavior
 * before it happens. Answers questions like:
 * - How many messages would a new prospect get in their first 30 days?
 * - What happens when someone never responds?
 * - How does Addie behave with a very active member?
 *
 * Also provides historical assessment by analyzing real person_events data
 * to characterize how aggressive Addie has been.
 */

import { createLogger } from '../../logger.js';
import { shouldContact, composeMessage, computeNextContactDate, getAvailableActions } from './engagement-planner.js';
import type { RelationshipContext, ComposedMessage } from './engagement-planner.js';
import type { PersonRelationship, RelationshipStage } from '../../db/relationship-db.js';
import { STAGE_ORDER } from '../../db/relationship-db.js';
import { getPool } from '../../db/client.js';

const logger = createLogger('outreach-simulator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A synthetic persona for simulation */
export interface SimulatedPersona {
  name: string;
  description: string;
  /** Starting stage */
  stage: RelationshipStage;
  /** Whether they have Slack */
  hasSlack: boolean;
  /** Whether they have email */
  hasEmail: boolean;
  /** How they respond to Addie */
  responseBehavior: 'never' | 'always' | 'sometimes' | 'after_n';
  /** For 'sometimes', probability of responding (0-1) */
  responseProbability?: number;
  /** For 'after_n', respond after this many messages */
  respondAfterN?: number;
  /** Company context */
  company?: {
    name: string;
    type: string;
    is_member: boolean;
  };
}

/** One simulated outreach attempt */
export interface SimulatedEvent {
  day: number;
  action: 'contacted' | 'skipped' | 'blocked' | 'person_responded';
  reason: string;
  channel?: 'slack' | 'email';
  unrepliedCount: number;
  stage: RelationshipStage;
}

/** Result of running a simulation */
export interface SimulationResult {
  persona: SimulatedPersona;
  durationDays: number;
  events: SimulatedEvent[];
  summary: {
    totalContacts: number;
    totalSkips: number;
    totalBlocks: number;
    personResponses: number;
    finalStage: RelationshipStage;
    finalUnreplied: number;
    daysBetweenContacts: number[];
    averageDaysBetweenContacts: number;
  };
}

/** Historical assessment of real outreach behavior */
export interface HistoricalAssessment {
  totalPeople: number;
  byStage: Array<{
    stage: string;
    count: number;
    avgUnreplied: number;
    maxUnreplied: number;
    avgDaysSinceContact: number | null;
    blockedCount: number;
  }>;
  overContactedPeople: Array<{
    personId: string;
    displayName: string | null;
    stage: string;
    unrepliedCount: number;
    messagesSent: number;
    messagesReceived: number;
    lastAddieMessage: string | null;
    lastPersonMessage: string | null;
  }>;
  recentOutreachRate: {
    last7d: number;
    last30d: number;
    avgPerDay7d: number;
    avgPerDay30d: number;
  };
  emailStats: {
    totalSent7d: number;
    totalSent30d: number;
    uniqueRecipients30d: number;
  };
}

// ---------------------------------------------------------------------------
// Built-in Personas
// ---------------------------------------------------------------------------

export const PERSONAS: SimulatedPersona[] = [
  {
    name: 'The Ghost',
    description: 'Joins Slack, never responds to anything',
    stage: 'prospect',
    hasSlack: true,
    hasEmail: false,
    responseBehavior: 'never',
    company: { name: 'Silent Corp', type: 'brand', is_member: false },
  },
  {
    name: 'The Engaged Prospect',
    description: 'Responds to every message, links account quickly',
    stage: 'prospect',
    hasSlack: true,
    hasEmail: true,
    responseBehavior: 'always',
    company: { name: 'Eager Inc', type: 'agency', is_member: false },
  },
  {
    name: 'The Slow Responder',
    description: 'Only responds after the 3rd message',
    stage: 'prospect',
    hasSlack: true,
    hasEmail: false,
    responseBehavior: 'after_n',
    respondAfterN: 3,
    company: { name: 'Eventually Co', type: 'tech_vendor', is_member: false },
  },
  {
    name: 'The Email-Only Prospect',
    description: 'No Slack presence, only email. Responds sometimes.',
    stage: 'prospect',
    hasSlack: false,
    hasEmail: true,
    responseBehavior: 'sometimes',
    responseProbability: 0.3,
    company: { name: 'Traditional Media', type: 'publisher', is_member: false },
  },
  {
    name: 'The Active Member',
    description: 'Already participating, responds about half the time',
    stage: 'participating',
    hasSlack: true,
    hasEmail: true,
    responseBehavior: 'sometimes',
    responseProbability: 0.5,
    company: { name: 'Active Agency', type: 'agency', is_member: true },
  },
  {
    name: 'The Busy Executive',
    description: 'Exploring stage, rarely responds',
    stage: 'exploring',
    hasSlack: true,
    hasEmail: true,
    responseBehavior: 'sometimes',
    responseProbability: 0.1,
    company: { name: 'Big Brand Co', type: 'brand', is_member: true },
  },
];

// ---------------------------------------------------------------------------
// Simulation Engine
// ---------------------------------------------------------------------------

/**
 * Run a simulation for a persona over N days.
 * Uses the real shouldContact() rules but simulates time progression.
 */
export function simulate(persona: SimulatedPersona, durationDays: number = 60): SimulationResult {
  const events: SimulatedEvent[] = [];

  // Create a synthetic relationship
  const relationship: PersonRelationship = {
    id: 'sim-' + Math.random().toString(36).slice(2),
    slack_user_id: persona.hasSlack ? 'USIM' + Math.random().toString(36).slice(2, 8).toUpperCase() : null,
    workos_user_id: null,
    email: persona.hasEmail ? `sim@${persona.company?.name.toLowerCase().replace(/\s/g, '')}.com` : null,
    prospect_org_id: persona.hasEmail && !persona.hasSlack ? 'org_sim_' + Math.random().toString(36).slice(2) : null,
    display_name: persona.name,
    stage: persona.stage,
    stage_changed_at: new Date(),
    last_addie_message_at: null,
    last_person_message_at: null,
    last_interaction_channel: null,
    next_contact_after: null,
    contact_preference: null as 'slack' | 'email' | null,
    slack_dm_channel_id: null,
    slack_dm_thread_ts: null,
    sentiment_trend: 'neutral' as const,
    interaction_count: 0,
    unreplied_outreach_count: 0,
    opted_out: false,
    created_at: new Date(),
    updated_at: new Date(),
  };

  let messagesSentToPersona = 0;

  // Simulate day by day
  for (let day = 0; day < durationDays; day++) {
    // Advance the simulated clock
    const simDate = new Date();
    simDate.setDate(simDate.getDate() + day);

    // Override Date.now for shouldContact (it checks cooldowns against current time)
    // Instead, we'll manually check the rules by manipulating the relationship dates
    // to be relative to "today" being `day` days from start

    // Check if Addie would contact this person
    const decision = shouldContact(relationship);

    if (!decision.shouldContact) {
      events.push({
        day,
        action: relationship.unreplied_outreach_count >= 3 ? 'blocked' : 'skipped',
        reason: decision.reason,
        stage: relationship.stage,
        unrepliedCount: relationship.unreplied_outreach_count,
      });
      continue;
    }

    // Addie decides to contact
    events.push({
      day,
      action: 'contacted',
      reason: decision.reason,
      channel: decision.channel,
      stage: relationship.stage,
      unrepliedCount: relationship.unreplied_outreach_count,
    });

    messagesSentToPersona++;

    // Update relationship state (what happens after sending)
    relationship.last_addie_message_at = simDate;
    relationship.unreplied_outreach_count++;
    relationship.interaction_count++;

    // Welcome → stage transition
    if (relationship.stage === 'prospect' && messagesSentToPersona === 1) {
      relationship.stage = 'welcomed';
      relationship.stage_changed_at = simDate;
    }

    // Set next contact based on stage cooldown
    const nextContact = computeNextContactDate(relationship.stage);
    // Adjust to be relative to the simulation day
    const cooldownMs = nextContact.getTime() - Date.now();
    const simNextContact = new Date(simDate.getTime() + cooldownMs);
    relationship.next_contact_after = simNextContact;

    // Simulate person response
    const responds = personResponds(persona, messagesSentToPersona);
    if (responds) {
      // Simulate response happening 1-2 days later
      const responseDay = Math.min(day + 1 + Math.floor(Math.random() * 2), durationDays - 1);
      const responseDate = new Date();
      responseDate.setDate(responseDate.getDate() + responseDay);

      events.push({
        day: responseDay,
        action: 'person_responded',
        reason: 'simulated response',
        stage: relationship.stage,
        unrepliedCount: 0,
      });

      relationship.last_person_message_at = responseDate;
      relationship.unreplied_outreach_count = 0;
      relationship.interaction_count++;

      // Advance stage on response
      if (relationship.stage === 'welcomed') {
        relationship.stage = 'exploring';
        relationship.stage_changed_at = responseDate;
      }
    }
  }

  // Sort events by day
  events.sort((a, b) => a.day - b.day);

  // Calculate summary
  const contacts = events.filter(e => e.action === 'contacted');
  const contactDays = contacts.map(e => e.day);
  const daysBetween: number[] = [];
  for (let i = 1; i < contactDays.length; i++) {
    daysBetween.push(contactDays[i] - contactDays[i - 1]);
  }

  return {
    persona,
    durationDays,
    events,
    summary: {
      totalContacts: contacts.length,
      totalSkips: events.filter(e => e.action === 'skipped').length,
      totalBlocks: events.filter(e => e.action === 'blocked').length,
      personResponses: events.filter(e => e.action === 'person_responded').length,
      finalStage: relationship.stage,
      finalUnreplied: relationship.unreplied_outreach_count,
      daysBetweenContacts: daysBetween,
      averageDaysBetweenContacts: daysBetween.length > 0
        ? Math.round(daysBetween.reduce((a, b) => a + b, 0) / daysBetween.length * 10) / 10
        : 0,
    },
  };
}

function personResponds(persona: SimulatedPersona, messagesSent: number): boolean {
  switch (persona.responseBehavior) {
    case 'never': return false;
    case 'always': return true;
    case 'sometimes': return Math.random() < (persona.responseProbability ?? 0.5);
    case 'after_n': return messagesSent >= (persona.respondAfterN ?? 3);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Historical Assessment
// ---------------------------------------------------------------------------

/**
 * Analyze real production data to characterize Addie's actual outreach behavior.
 */
export async function assessHistoricalBehavior(): Promise<HistoricalAssessment> {
  const pool = getPool();

  // Stage breakdown with unreplied stats
  const stageResult = await pool.query(`
    SELECT
      stage,
      COUNT(*) as count,
      AVG(unreplied_outreach_count) as avg_unreplied,
      MAX(unreplied_outreach_count) as max_unreplied,
      AVG(EXTRACT(EPOCH FROM (NOW() - last_addie_message_at)) / 86400)
        FILTER (WHERE last_addie_message_at IS NOT NULL) as avg_days_since_contact,
      COUNT(*) FILTER (WHERE unreplied_outreach_count >= 3) as blocked_count
    FROM person_relationships
    WHERE opted_out = FALSE
    GROUP BY stage
    ORDER BY CASE stage
      WHEN 'prospect' THEN 1 WHEN 'welcomed' THEN 2
      WHEN 'exploring' THEN 3 WHEN 'participating' THEN 4
      WHEN 'contributing' THEN 5 WHEN 'leading' THEN 6
    END
  `);

  // People who are being over-contacted (2+ unreplied)
  const overContactedResult = await pool.query(`
    SELECT
      pr.id as person_id,
      pr.display_name,
      pr.stage,
      pr.unreplied_outreach_count,
      (SELECT COUNT(*) FROM person_events pe
       WHERE pe.person_id = pr.id AND pe.event_type = 'message_sent') as messages_sent,
      (SELECT COUNT(*) FROM person_events pe
       WHERE pe.person_id = pr.id AND pe.event_type = 'message_received') as messages_received,
      pr.last_addie_message_at,
      pr.last_person_message_at
    FROM person_relationships pr
    WHERE pr.unreplied_outreach_count >= 2
      AND pr.opted_out = FALSE
    ORDER BY pr.unreplied_outreach_count DESC, pr.last_addie_message_at DESC
    LIMIT 50
  `);

  // Recent outreach volume
  const volumeResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') as last_7d,
      COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '30 days') as last_30d
    FROM person_events
    WHERE event_type = 'message_sent'
  `);

  // Email stats
  const emailResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') as sent_7d,
      COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '30 days') as sent_30d,
      COUNT(DISTINCT person_id) FILTER (WHERE occurred_at > NOW() - INTERVAL '30 days') as unique_recipients_30d
    FROM person_events
    WHERE event_type = 'message_sent' AND channel = 'email'
  `);

  const totalResult = await pool.query(`SELECT COUNT(*) as total FROM person_relationships WHERE opted_out = FALSE`);

  const vol = volumeResult.rows[0];
  const email = emailResult.rows[0];

  return {
    totalPeople: parseInt(totalResult.rows[0]?.total ?? '0'),
    byStage: stageResult.rows.map(r => ({
      stage: r.stage,
      count: parseInt(r.count),
      avgUnreplied: parseFloat(Number(r.avg_unreplied).toFixed(1)),
      maxUnreplied: parseInt(r.max_unreplied),
      avgDaysSinceContact: r.avg_days_since_contact != null
        ? parseFloat(Number(r.avg_days_since_contact).toFixed(1))
        : null,
      blockedCount: parseInt(r.blocked_count),
    })),
    overContactedPeople: overContactedResult.rows.map(r => ({
      personId: r.person_id,
      displayName: r.display_name,
      stage: r.stage,
      unrepliedCount: parseInt(r.unreplied_outreach_count),
      messagesSent: parseInt(r.messages_sent),
      messagesReceived: parseInt(r.messages_received),
      lastAddieMessage: r.last_addie_message_at?.toISOString() ?? null,
      lastPersonMessage: r.last_person_message_at?.toISOString() ?? null,
    })),
    recentOutreachRate: {
      last7d: parseInt(vol.last_7d),
      last30d: parseInt(vol.last_30d),
      avgPerDay7d: Math.round(parseInt(vol.last_7d) / 7 * 10) / 10,
      avgPerDay30d: Math.round(parseInt(vol.last_30d) / 30 * 10) / 10,
    },
    emailStats: {
      totalSent7d: parseInt(email.sent_7d),
      totalSent30d: parseInt(email.sent_30d),
      uniqueRecipients30d: parseInt(email.unique_recipients_30d),
    },
  };
}

// ---------------------------------------------------------------------------
// Run All Simulations
// ---------------------------------------------------------------------------

/**
 * Run simulations for all built-in personas and return results.
 */
export function runAllSimulations(durationDays: number = 60): SimulationResult[] {
  return PERSONAS.map(persona => simulate(persona, durationDays));
}
