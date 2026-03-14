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

/** Stage cooldowns in days — mirrors STAGE_COOLDOWNS in engagement-planner.ts */
const SIM_COOLDOWNS: Record<RelationshipStage, number> = {
  prospect: 0,
  welcomed: 3,
  exploring: 7,
  participating: 14,
  contributing: 30,
  leading: 30,
};

const MAX_UNREPLIED_BEFORE_PULSE = 3;
const MONTHLY_PULSE_DAYS = 30;

/**
 * Run a simulation for a persona over N days.
 * Reimplements shouldContact() rules with simulated time so we don't fight
 * Date.now() mismatches. This is the pure, deterministic version.
 */
export function simulate(persona: SimulatedPersona, durationDays: number = 60): SimulationResult {
  const events: SimulatedEvent[] = [];

  // State tracking (not a real PersonRelationship — just the fields we need)
  let stage: RelationshipStage = persona.stage;
  let unrepliedCount = 0;
  let lastAddieMessageDay: number | null = null;
  let lastPersonMessageDay: number | null = null;
  let nextContactAfterDay: number | null = null;
  let interactionCount = 0;
  let messagesSentToPersona = 0;

  // Pending response (queued for a future day)
  let pendingResponseDay: number | null = null;

  for (let day = 0; day < durationDays; day++) {
    // Process pending response first
    if (pendingResponseDay !== null && day >= pendingResponseDay) {
      events.push({
        day,
        action: 'person_responded',
        reason: 'simulated response',
        stage,
        unrepliedCount: 0,
      });
      lastPersonMessageDay = day;
      unrepliedCount = 0;
      interactionCount++;
      pendingResponseDay = null;

      // Advance stage on response
      if (stage === 'welcomed') {
        stage = 'exploring';
      }
    }

    // Determine channel
    let channel: 'slack' | 'email';
    if (persona.hasSlack) {
      channel = 'slack';
    } else if (persona.hasEmail) {
      channel = 'email';
    } else {
      continue; // no channel
    }

    // Apply shouldContact rules with simulated time
    let shouldContact = true;
    let reason = 'eligible for proactive contact';

    // Rule 1: 3+ unreplied — switch to monthly pulse
    if (unrepliedCount >= MAX_UNREPLIED_BEFORE_PULSE) {
      if (lastAddieMessageDay !== null) {
        const daysSinceLast = day - lastAddieMessageDay;
        if (daysSinceLast < MONTHLY_PULSE_DAYS) {
          events.push({ day, action: 'blocked', reason: `${unrepliedCount} unreplied — monthly pulse in ${MONTHLY_PULSE_DAYS - daysSinceLast}d`, stage, unrepliedCount });
          continue;
        }
      }
      // 30+ days since last message — allow monthly pulse
      reason = 'monthly pulse — low-key update';
      // Skip remaining cooldown checks — pulse overrides them
    } else {
      // Rule 2: next_contact_after cooldown
      if (nextContactAfterDay !== null && day < nextContactAfterDay) {
        shouldContact = false;
        reason = `cooldown — next contact after day ${nextContactAfterDay}`;
        events.push({ day, action: 'skipped', reason, stage, unrepliedCount });
        continue;
      }

      // Rule 3: Stage-based cooldown on last_addie_message_at
      if (lastAddieMessageDay !== null) {
        const daysSinceLast = day - lastAddieMessageDay;
        let cooldown = SIM_COOLDOWNS[stage];
        // Escalate if 2+ unreplied
        if (unrepliedCount >= 2) {
          const currentIdx = STAGE_ORDER.indexOf(stage);
          const nextStage = STAGE_ORDER[Math.min(currentIdx + 1, STAGE_ORDER.length - 1)];
          cooldown = Math.max(cooldown, SIM_COOLDOWNS[nextStage]);
        }
        if (daysSinceLast < cooldown) {
          shouldContact = false;
          reason = `stage cooldown — ${stage} requires ${cooldown}d, only ${daysSinceLast}d`;
          events.push({ day, action: 'skipped', reason, stage, unrepliedCount });
          continue;
        }
      }

      // Rule 4: New prospect welcome
      if (stage === 'prospect' && lastAddieMessageDay === null) {
        reason = 'new prospect — welcome message';
      }
    }

    if (!shouldContact) continue;

    // Contact!
    events.push({ day, action: 'contacted', reason, channel, stage, unrepliedCount });
    messagesSentToPersona++;
    lastAddieMessageDay = day;
    unrepliedCount++;
    interactionCount++;

    // Stage transition: prospect → welcomed on first message
    if (stage === 'prospect' && messagesSentToPersona === 1) {
      stage = 'welcomed';
    }

    // Set next contact cooldown
    nextContactAfterDay = day + SIM_COOLDOWNS[stage];

    // Check if person responds
    const responds = personResponds(persona, messagesSentToPersona);
    if (responds) {
      // Response comes 1-2 days later
      pendingResponseDay = day + 1 + Math.floor(Math.random() * 2);
      if (pendingResponseDay >= durationDays) pendingResponseDay = null;
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
      finalStage: stage,
      finalUnreplied: unrepliedCount,
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
