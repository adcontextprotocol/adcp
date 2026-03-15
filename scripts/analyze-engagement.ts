/**
 * Analyze engagement opportunities and cadence for all personas.
 * Tests the scoring pipeline and simulator together.
 *
 * Usage: npx tsx scripts/analyze-engagement.ts
 */

import { runAllSimulations, PERSONAS } from '../server/src/addie/services/outreach-simulator.js';
import { computeEngagementOpportunities } from '../server/src/addie/services/engagement-planner.js';
import type { RelationshipStage } from '../server/src/db/relationship-db.js';

function main() {
  // ═══════════════════════════════════════════════════════════════
  // PART 1: Cadence analysis via simulation
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
        relationship: {
          id: 'sim', display_name: persona.name,
          slack_user_id: persona.hasSlack ? 'U1' : null,
          email: persona.hasEmail ? 'test@test.com' : null,
          workos_user_id: null, prospect_org_id: 'org-1',
          stage, sentiment_trend: 'neutral', interaction_count: 0,
          unreplied_outreach_count: 0, last_addie_message_at: null,
          last_person_message_at: null, next_contact_after: null,
          contact_preference: null, opted_out: false,
          created_at: new Date(), updated_at: new Date(),
        },
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
      relationship: {
        id: 'sim', display_name: persona.name,
        slack_user_id: persona.hasSlack ? 'U1' : null,
        email: persona.hasEmail ? 'test@test.com' : null,
        workos_user_id: 'w1', prospect_org_id: null,
        stage: 'participating', sentiment_trend: 'positive', interaction_count: 15,
        unreplied_outreach_count: 0, last_addie_message_at: new Date(Date.now() - 14 * 86400000),
        last_person_message_at: new Date(Date.now() - 7 * 86400000), next_contact_after: null,
        contact_preference: null, opted_out: false,
        created_at: new Date(Date.now() - 90 * 86400000), updated_at: new Date(),
      },
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
    relationship: {
      id: 'sim', display_name: 'Test User',
      slack_user_id: 'U1', email: 'test@test.com',
      workos_user_id: null, prospect_org_id: 'org-1',
      stage: 'exploring' as RelationshipStage, sentiment_trend: 'neutral' as const, interaction_count: 3,
      unreplied_outreach_count: 0, last_addie_message_at: null,
      last_person_message_at: null, next_contact_after: null,
      contact_preference: null, opted_out: false,
      created_at: new Date(), updated_at: new Date(),
    },
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
}

main();
