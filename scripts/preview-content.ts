/**
 * Preview what Addie would actually say to each persona.
 * Calls composeMessage() with synthetic contexts at key moments:
 * - First contact (welcome)
 * - Follow-up (after no response)
 * - Monthly pulse (after going quiet)
 *
 * Usage: npx tsx scripts/preview-content.ts
 * Requires ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY env var.
 */

import { PERSONAS, type SimulatedPersona } from '../server/src/addie/services/outreach-simulator.js';
import { composeMessage, computeEngagementOpportunities } from '../server/src/addie/services/engagement-planner.js';
import type { RelationshipContext } from '../server/src/addie/services/engagement-planner.js';
import type { PersonRelationship, RelationshipStage } from '../server/src/db/relationship-db.js';

// ---------------------------------------------------------------------------
// Build a synthetic RelationshipContext from a persona + scenario
// ---------------------------------------------------------------------------

type Scenario = 'welcome' | 'follow_up' | 'monthly_pulse';

function buildContext(persona: SimulatedPersona, scenario: Scenario): { ctx: RelationshipContext; channel: 'slack' | 'email' } {
  const channel: 'slack' | 'email' = persona.hasSlack ? 'slack' : 'email';
  const now = new Date();

  // Build a fake PersonRelationship with the fields composeMessage needs
  const base: PersonRelationship = {
    id: 'sim-' + persona.name.toLowerCase().replace(/\s+/g, '-'),
    display_name: persona.name.replace('The ', ''),
    slack_user_id: persona.hasSlack ? 'U_SIM_SLACK' : null,
    email: persona.hasEmail ? `${persona.name.toLowerCase().replace(/\s+/g, '.')}@example.com` : null,
    workos_user_id: null,
    prospect_org_id: null,
    stage: 'prospect' as RelationshipStage,
    sentiment_trend: 'neutral' as const,
    interaction_count: 0,
    unreplied_outreach_count: 0,
    last_addie_message_at: null,
    last_person_message_at: null,
    next_contact_after: null,
    contact_preference: null,
    opted_out: false,
    created_at: new Date(now.getTime() - 90 * 86400000),
    updated_at: now,
  };

  let recentMessages: RelationshipContext['recentMessages'] = [];

  switch (scenario) {
    case 'welcome':
      // First contact — prospect, no history
      base.stage = 'prospect';
      base.interaction_count = 0;
      break;

    case 'follow_up':
      // Second contact — welcomed, 1 unreplied, Addie sent 3 days ago
      base.stage = 'welcomed';
      base.interaction_count = 1;
      base.unreplied_outreach_count = 1;
      base.last_addie_message_at = new Date(now.getTime() - 3 * 86400000);
      recentMessages = [{
        role: 'assistant',
        content: `Hey ${base.display_name?.split(' ')[0]}! Welcome to AgenticAdvertising.org. I'm Addie, the community manager here. I noticed ${persona.company?.name ?? 'your company'} just joined — really excited to have you. What's your team working on in the agentic advertising space?`,
        channel,
        created_at: new Date(now.getTime() - 3 * 86400000),
      }];
      break;

    case 'monthly_pulse':
      // Monthly pulse — 3+ unreplied, last message 30+ days ago
      base.stage = 'welcomed';
      base.interaction_count = 3;
      base.unreplied_outreach_count = 3;
      base.last_addie_message_at = new Date(now.getTime() - 35 * 86400000);
      recentMessages = [
        {
          role: 'assistant',
          content: `Hey ${base.display_name?.split(' ')[0]}! Welcome to AgenticAdvertising.org.`,
          channel,
          created_at: new Date(now.getTime() - 45 * 86400000),
        },
        {
          role: 'assistant',
          content: `Just checking in — wanted to make sure you found everything okay. Let me know if you have questions about the community.`,
          channel,
          created_at: new Date(now.getTime() - 42 * 86400000),
        },
        {
          role: 'assistant',
          content: `Quick heads up — we have a working group session on programmatic standards next week. Thought it might be relevant for ${persona.company?.name ?? 'your team'}.`,
          channel,
          created_at: new Date(now.getTime() - 35 * 86400000),
        },
      ];
      break;
  }

  const engagementOpportunities = computeEngagementOpportunities({
    relationship: base,
    capabilities: null,
    company: persona.company ? {
      name: persona.company.name,
      type: persona.company.type,
      is_member: persona.company.is_member,
    } : null,
    recentMessages,
    certification: null,
  });

  const ctx: RelationshipContext = {
    relationship: base,
    recentMessages,
    profile: {
      capabilities: null,
      company: persona.company ? {
        name: persona.company.name,
        type: persona.company.type,
        is_member: persona.company.is_member,
      } : null,
    },
    engagementOpportunities,
  };

  return { ctx, channel };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = ['welcome', 'follow_up', 'monthly_pulse'];
const scenarioLabels: Record<Scenario, string> = {
  welcome: 'Welcome (first contact)',
  follow_up: 'Follow-up (1 unreplied, 3 days later)',
  monthly_pulse: 'Monthly pulse (3 unreplied, 35 days later)',
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ADDIE_ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('CONTENT PREVIEW — What would Addie actually say?');
  console.log(`${'='.repeat(80)}\n`);

  for (const persona of PERSONAS) {
    console.log(`${'━'.repeat(80)}`);
    console.log(`${persona.name} — ${persona.description}`);
    console.log(`  Company: ${persona.company?.name ?? '?'} (${persona.company?.type ?? '?'})`);
    console.log(`  Channels: ${[persona.hasSlack && 'Slack', persona.hasEmail && 'email'].filter(Boolean).join(', ')}`);
    console.log();

    for (const scenario of scenarios) {
      const { ctx, channel } = buildContext(persona, scenario);
      console.log(`  ┌─ ${scenarioLabels[scenario]} (${channel})`);

      const contactReasons: Record<Scenario, string> = {
        welcome: 'new prospect — welcome message',
        follow_up: 'eligible for proactive contact',
        monthly_pulse: 'monthly pulse — low-key update',
      };
      try {
        const message = await composeMessage(ctx, channel, contactReasons[scenario]);
        if (message) {
          if (message.subject) {
            console.log(`  │ Subject: ${message.subject}`);
          }
          const lines = message.text.split('\n');
          for (const line of lines) {
            console.log(`  │ ${line}`);
          }
        } else {
          console.log(`  │ \x1b[90m(Sonnet chose to skip — nothing meaningful to say)\x1b[0m`);
        }
      } catch (err: any) {
        console.log(`  │ \x1b[31mError: ${err.message}\x1b[0m`);
      }
      console.log(`  └${'─'.repeat(60)}`);
      console.log();
    }
  }
}

main().catch(console.error);
