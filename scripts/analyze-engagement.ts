/**
 * Analyze engagement opportunities and cadence for all personas.
 * Tests the scoring pipeline and simulator together.
 *
 * Usage: npx tsx scripts/analyze-engagement.ts
 */

import { runAllSimulations, simulate, PERSONAS } from '../server/src/addie/services/outreach-simulator.js';
import type { SimulatedPersona } from '../server/src/addie/services/outreach-simulator.js';
import { computeEngagementOpportunities } from '../server/src/addie/services/engagement-planner.js';
import type { RelationshipStage } from '../server/src/db/relationship-db.js';

// Helper to build a relationship object with all required fields
function makeRel(overrides: Partial<{
  id: string; display_name: string; slack_user_id: string | null; email: string | null;
  workos_user_id: string | null; prospect_org_id: string | null;
  stage: RelationshipStage; sentiment_trend: string; interaction_count: number;
  unreplied_outreach_count: number; last_addie_message_at: Date | null;
  last_person_message_at: Date | null; next_contact_after: Date | null;
  contact_preference: 'slack' | 'email' | null; opted_out: boolean;
  stage_changed_at: Date; last_interaction_channel: string | null;
  slack_dm_channel_id: string | null; slack_dm_thread_ts: string | null;
}> = {}) {
  return {
    id: 'sim', display_name: 'Test User',
    slack_user_id: 'U1', email: 'test@test.com',
    workos_user_id: null, prospect_org_id: 'org-1',
    stage: 'prospect' as RelationshipStage, sentiment_trend: 'neutral',
    interaction_count: 0, unreplied_outreach_count: 0,
    last_addie_message_at: null, last_person_message_at: null,
    next_contact_after: null, contact_preference: null, opted_out: false,
    created_at: new Date(), updated_at: new Date(),
    stage_changed_at: new Date(), last_interaction_channel: null,
    slack_dm_channel_id: null, slack_dm_thread_ts: null,
    ...overrides,
  };
}

function main() {
  // ═══════════════════════════════════════════════════════════════
  // PART 1: Cadence analysis via simulation (90 days, built-in personas)
  // ═══════════════════════════════════════════════════════════════
  const results = runAllSimulations(90);

  console.log('='.repeat(80));
  console.log('CADENCE ANALYSIS — 90 days per persona');
  console.log('='.repeat(80));

  for (const r of results) {
    const s = r.summary;
    console.log();
    console.log('━'.repeat(60));
    console.log(`${r.persona.name} — ${r.persona.description}`);
    console.log(`  Contacts: ${s.totalContacts}  Skips: ${s.totalSkips}  Blocks: ${s.totalBlocks}  Responses: ${s.personResponses}`);
    console.log(`  Final stage: ${s.finalStage}  Final unreplied: ${s.finalUnreplied}`);
    console.log(`  Avg days between contacts: ${s.averageDaysBetweenContacts}`);
    console.log(`  Days between contacts: [${s.daysBetweenContacts.join(', ')}]`);

    // Show contact timeline (skip 'skipped' events to keep it readable)
    console.log('  Timeline:');
    for (const e of r.events.filter(e => e.action !== 'skipped')) {
      const icon = e.action === 'contacted' ? '→' : e.action === 'person_responded' ? '←' : '✕';
      console.log(`    Day ${String(e.day).padStart(2)} ${icon} ${e.action} (${e.reason}) [${e.stage}, unreplied:${e.unrepliedCount}]`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 2: Engagement opportunities per persona at key stages
  // ═══════════════════════════════════════════════════════════════
  console.log();
  console.log('='.repeat(80));
  console.log('ENGAGEMENT OPPORTUNITIES — per persona at key stages');
  console.log('='.repeat(80));

  const stages: RelationshipStage[] = ['prospect', 'welcomed', 'exploring', 'participating'];

  // Test with no insights (first contact)
  console.log('\n── No insights (first contact) ──');
  for (const persona of PERSONAS) {
    console.log();
    console.log(`  ${persona.name} (${persona.company?.type ?? '?'})`);
    for (const stage of stages) {
      const opps = computeEngagementOpportunities({
        relationship: makeRel({
          display_name: persona.name,
          slack_user_id: persona.hasSlack ? 'U1' : null,
          email: persona.hasEmail ? 'test@test.com' : null,
          stage,
        }),
        capabilities: null,
        insights: [],
        company: persona.company ? { name: persona.company.name, type: persona.company.type, is_member: persona.company.is_member } : null,
        recentMessages: [],
        certification: null,
      });
      console.log(`    ${stage}:`);
      for (const o of opps) {
        console.log(`      [${o.dimension.padEnd(11)}] ${o.description} (${o.relevance})`);
      }
    }
  }

  // Test with insights + capabilities (engaged member)
  console.log('\n── With insights + capabilities (engaged member) ──');
  for (const persona of PERSONAS) {
    console.log();
    console.log(`  ${persona.name} (${persona.company?.type ?? '?'})`);

    const opps = computeEngagementOpportunities({
      relationship: makeRel({
        display_name: persona.name,
        slack_user_id: persona.hasSlack ? 'U1' : null,
        email: persona.hasEmail ? 'test@test.com' : null,
        workos_user_id: 'w1', prospect_org_id: null,
        stage: 'participating', sentiment_trend: 'positive', interaction_count: 15,
        unreplied_outreach_count: 0, last_addie_message_at: new Date(Date.now() - 14 * 86400000),
        last_person_message_at: new Date(Date.now() - 7 * 86400000),
      }),
      capabilities: {
        account_linked: true, profile_complete: true, offerings_set: false,
        email_prefs_configured: true, working_group_count: 1, council_count: 0,
        events_registered: 2, events_attended: 1, community_profile_public: true,
        community_profile_completeness: 75, has_team_members: false, is_org_admin: true,
        is_committee_leader: false, slack_message_count_30d: 8,
      },
      insights: [
        { type: 'role', value: 'Head of Programmatic', confidence: 'high' },
        { type: 'building', value: 'Custom bidder integration', confidence: 'high' },
        { type: 'interest', value: 'OpenRTB, supply path optimization', confidence: 'high' },
      ],
      company: persona.company ? { name: persona.company.name, type: persona.company.type, is_member: persona.company.is_member } : null,
      recentMessages: [],
      certification: { modulesCompleted: 3, totalModules: 10, credentialsEarned: ['adcp-basics'], hasInProgressTrack: true },
    });
    console.log(`    participating (engaged, partial cert):`);
    for (const o of opps) {
      console.log(`      [${o.dimension.padEnd(11)}] ${o.description} (${o.relevance})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 3: Recency penalty demonstration
  // ═══════════════════════════════════════════════════════════════
  console.log();
  console.log('='.repeat(80));
  console.log('RECENCY PENALTY — before and after mentioning working groups');
  console.log('='.repeat(80));

  const baseCtx = {
    relationship: makeRel({ stage: 'exploring' as RelationshipStage, interaction_count: 3 }),
    capabilities: null,
    insights: [] as Array<{ type: string; value: string; confidence: string }>,
    company: { name: 'Test Corp', type: 'agency', is_member: false },
    certification: null,
  };

  const before = computeEngagementOpportunities({ ...baseCtx, recentMessages: [] });
  console.log('\n  Before (no recent messages):');
  for (const o of before) {
    console.log(`    [${o.dimension.padEnd(11)}] ${o.description} (${o.relevance})`);
  }

  const after = computeEngagementOpportunities({
    ...baseCtx,
    recentMessages: [{
      role: 'assistant' as const,
      content: 'Have you checked out our working groups? There are several relevant to your interests in programmatic.',
      channel: 'slack',
      created_at: new Date(),
    }],
  });
  console.log('\n  After (just mentioned working groups):');
  for (const o of after) {
    console.log(`    [${o.dimension.padEnd(11)}] ${o.description} (${o.relevance})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 4: Complex personas — 180-day simulations
  // ═══════════════════════════════════════════════════════════════
  console.log();
  console.log('='.repeat(80));
  console.log('COMPLEX PERSONAS — 180-day simulations');
  console.log('='.repeat(80));

  const complexPersonas: SimulatedPersona[] = [
    {
      name: 'The VP Who Replies Once Then Goes Dark',
      description: 'Responds to welcome, then never again',
      stage: 'prospect',
      hasSlack: true,
      hasEmail: true,
      responseBehavior: 'after_n',
      respondAfterN: 1,
      company: { name: 'Major Brand Inc', type: 'brand', is_member: false },
    },
    {
      name: 'The Tire Kicker',
      description: 'Responds ~20% of the time, never commits to anything',
      stage: 'prospect',
      hasSlack: true,
      hasEmail: true,
      responseBehavior: 'sometimes',
      responseProbability: 0.2,
      company: { name: 'Curious Agency', type: 'agency', is_member: false },
    },
    {
      name: 'The Email-Only Enterprise Buyer',
      description: 'No Slack, only email. Responds after 5 messages.',
      stage: 'prospect',
      hasSlack: false,
      hasEmail: true,
      responseBehavior: 'after_n',
      respondAfterN: 5,
      company: { name: 'Enterprise Corp', type: 'brand', is_member: false },
    },
    {
      name: 'The Power User',
      description: 'Already participating, responds to everything',
      stage: 'participating',
      hasSlack: true,
      hasEmail: true,
      responseBehavior: 'always',
      company: { name: 'Tech Startup', type: 'tech_vendor', is_member: true },
    },
    {
      name: 'The Conference Attendee',
      description: 'Met at a conference, has email only. Responds sometimes.',
      stage: 'prospect',
      hasSlack: false,
      hasEmail: true,
      responseBehavior: 'sometimes',
      responseProbability: 0.3,
      company: { name: 'Regional Publisher', type: 'publisher', is_member: false },
    },
    {
      name: 'The Slack Lurker',
      description: 'Joined Slack, reads everything, never responds',
      stage: 'prospect',
      hasSlack: true,
      hasEmail: false,
      responseBehavior: 'never',
      company: { name: 'Stealth Startup', type: 'tech_vendor', is_member: false },
    },
    {
      name: 'The Intermittent Responder',
      description: 'Responds roughly every 3rd message, dual channel',
      stage: 'prospect',
      hasSlack: true,
      hasEmail: true,
      responseBehavior: 'sometimes',
      responseProbability: 0.33,
      company: { name: 'Mid-Size Agency', type: 'agency', is_member: false },
    },
  ];

  for (const persona of complexPersonas) {
    const r = simulate(persona, 180);
    const s = r.summary;
    console.log();
    console.log('━'.repeat(60));
    console.log(`${persona.name} — ${persona.description}`);
    console.log(`  Company: ${persona.company?.name} (${persona.company?.type})`);
    console.log(`  Channels: ${persona.hasSlack ? 'Slack' : ''}${persona.hasSlack && persona.hasEmail ? '+' : ''}${persona.hasEmail ? 'Email' : ''}`);
    console.log(`  Contacts: ${s.totalContacts}  Blocks: ${s.totalBlocks}  Responses: ${s.personResponses}`);
    console.log(`  Final stage: ${s.finalStage}  Final unreplied: ${s.finalUnreplied}`);
    console.log(`  Avg days between contacts: ${s.averageDaysBetweenContacts}`);
    if (s.daysBetweenContacts.length > 0) {
      console.log(`  Days between contacts: [${s.daysBetweenContacts.join(', ')}]`);
    }

    // Show full timeline (contacts, responses, blocks — skip daily "skipped" noise)
    console.log('  Timeline:');
    for (const e of r.events.filter(e => e.action !== 'skipped')) {
      const icon = e.action === 'contacted' ? '→' : e.action === 'person_responded' ? '←' : '✕';
      console.log(`    Day ${String(e.day).padStart(3)} ${icon} ${e.action} (${e.reason}) [${e.stage}, unreplied:${e.unrepliedCount}]`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 5: Monthly pulse scoring — what Sonnet sees for pulse contacts
  // ═══════════════════════════════════════════════════════════════
  console.log();
  console.log('='.repeat(80));
  console.log('MONTHLY PULSE SCORING — normal vs pulse context');
  console.log('='.repeat(80));

  const pulseCtx = {
    relationship: makeRel({
      stage: 'welcomed' as RelationshipStage,
      unreplied_outreach_count: 3,
      last_addie_message_at: new Date(Date.now() - 35 * 86400000),
    }),
    capabilities: null,
    insights: [{ type: 'role', value: 'Media Director', confidence: 'high' }],
    company: { name: 'Silent Agency', type: 'agency', is_member: false },
    recentMessages: [] as Array<{ role: 'user' | 'assistant'; content: string; channel: string; created_at: Date }>,
    certification: null,
  };

  const normalOpps = computeEngagementOpportunities(pulseCtx);
  const pulseOpps = computeEngagementOpportunities(pulseCtx, 'monthly pulse — low-key update');

  console.log('\n  Normal scoring:');
  for (const o of normalOpps) {
    console.log(`    [${o.dimension.padEnd(11)}] ${o.id.padEnd(25)} score: ${o.relevance}`);
  }
  console.log('\n  Monthly pulse scoring (community boosted 1.5x):');
  for (const o of pulseOpps) {
    console.log(`    [${o.dimension.padEnd(11)}] ${o.id.padEnd(25)} score: ${o.relevance}`);
  }
}

main();
