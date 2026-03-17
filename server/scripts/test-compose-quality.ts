/**
 * Test harness for outreach compose quality.
 * Runs 6 personas through composeMessage() and checks output quality.
 *
 * Usage: ANTHROPIC_API_KEY=sk-... npx tsx server/scripts/test-compose-quality.ts
 */

import {
  composeMessage,
  computeEngagementOpportunities,
  COMPOSE_SYSTEM_PROMPT,
  type RelationshipContext,
  type EngagementContext,
  type CertificationSummary,
} from '../src/addie/services/engagement-planner.js';
import type { PersonRelationship, RelationshipStage } from '../src/db/relationship-db.js';
import type { MemberCapabilities } from '../src/addie/types.js';

if (!process.env.ANTHROPIC_API_KEY && !process.env.ADDIE_ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY to run this script.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function makeRelationship(overrides: Partial<PersonRelationship> = {}): PersonRelationship {
  return {
    id: 'test-' + Math.random().toString(36).slice(2, 8),
    display_name: 'Test User',
    email: 'test@example.com',
    slack_user_id: 'U_TEST',
    workos_user_id: null,
    stage: 'exploring' as RelationshipStage,
    interaction_count: 0,
    unreplied_outreach_count: 0,
    last_addie_message_at: null,
    last_person_message_at: null,
    sentiment_trend: 'neutral',
    stage_changed_at: daysAgo(30),
    contact_preference: null,
    opted_out: false,
    prospect_org_id: null,
    next_contact_after: null,
    slack_dm_thread_ts: null,
    ...overrides,
  } as PersonRelationship;
}

function makeCaps(overrides: Partial<MemberCapabilities> = {}): MemberCapabilities {
  return {
    account_linked: false,
    profile_complete: false,
    offerings_set: false,
    email_prefs_configured: false,
    community_profile_public: false,
    has_team_members: false,
    is_org_admin: false,
    is_committee_leader: false,
    working_group_count: 0,
    council_count: 0,
    events_registered: 0,
    events_attended: 0,
    community_profile_completeness: 0,
    slack_message_count_30d: 0,
    offerings_count: 0,
    ...overrides,
  };
}

interface Persona {
  name: string;
  description: string;
  context: RelationshipContext;
  channel: 'slack' | 'email';
  contactReason?: string;
  checks: Check[];
}

interface Check {
  name: string;
  test: (text: string | null, skipped: boolean) => boolean;
}

// ---------------------------------------------------------------------------
// Quality checks
// ---------------------------------------------------------------------------

const HEDGE_WORDS = ['might be worth', 'if you get a chance', 'worth a few minutes', 'when you get a chance', 'worth a look'];

const checkUnder280: Check = {
  name: 'Under 280 chars',
  test: (text) => text === null || text.length <= 280,
};

const checkNoHedge: Check = {
  name: 'No hedge language',
  test: (text) => {
    if (!text) return true;
    const lower = text.toLowerCase();
    return !HEDGE_WORDS.some(h => lower.includes(h));
  },
};

const checkNoHomeworkQuestion: Check = {
  name: 'No open-ended homework questions',
  test: (text) => {
    if (!text) return true;
    const lower = text.toLowerCase();
    const patterns = [
      "what's pulling your attention",
      "what are you hoping to get out of",
      "what draws you",
      "what's drawing you",
      "what are you focused on these days",
    ];
    return !patterns.some(p => lower.includes(p));
  },
};

const checkShouldSkip: Check = {
  name: 'Should SKIP (no specific context)',
  test: (_text, skipped) => skipped,
};

const checkShouldSend: Check = {
  name: 'Should SEND a message',
  test: (_text, skipped) => !skipped,
};

const checkNoCTA: Check = {
  name: 'No asks/CTAs (pulse message)',
  test: (text) => {
    if (!text) return true;
    const lower = text.toLowerCase();
    const ctaPatterns = ['want me to', 'should i', 'want an intro', 'want to join', 'check out', 'sign up', 'fill out', 'complete your profile'];
    return !ctaPatterns.some(p => lower.includes(p));
  },
};

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

function buildPersonas(): Persona[] {
  // 1. Ghost with company metadata only
  const ghost = makeRelationship({
    display_name: 'Alex Thompson',
    stage: 'welcomed',
    workos_user_id: 'user_ghost',
    interaction_count: 1,
    unreplied_outreach_count: 1,
    last_addie_message_at: daysAgo(15),
    last_person_message_at: null,
  });
  const ghostCaps = makeCaps({ account_linked: true });

  // 2. Welcomed user who replied about WGs
  const replier = makeRelationship({
    display_name: 'Maria Chen',
    stage: 'welcomed',
    workos_user_id: 'user_replier',
    interaction_count: 2,
    unreplied_outreach_count: 0,
    last_addie_message_at: daysAgo(10),
    last_person_message_at: daysAgo(9),
  });
  const replierCaps = makeCaps({ account_linked: true, slack_message_count_30d: 2 });

  // 3. Exploring agency with Slack activity
  const slackActive = makeRelationship({
    display_name: 'James Park',
    stage: 'exploring',
    workos_user_id: 'user_slack',
    interaction_count: 0,
    unreplied_outreach_count: 0,
    last_addie_message_at: daysAgo(20),
    last_person_message_at: null,
  });
  const slackActiveCaps = makeCaps({
    account_linked: true,
    slack_message_count_30d: 15,
    working_group_count: 1,
    profile_complete: true,
  });

  // 4. Participating member with cert progress
  const certMember = makeRelationship({
    display_name: 'Priya Sharma',
    stage: 'participating',
    workos_user_id: 'user_cert',
    interaction_count: 4,
    unreplied_outreach_count: 0,
    last_addie_message_at: daysAgo(35),
    last_person_message_at: daysAgo(20),
  });
  const certCaps = makeCaps({
    account_linked: true,
    working_group_count: 2,
    slack_message_count_30d: 8,
    profile_complete: true,
    community_profile_public: true,
  });
  const certInfo: CertificationSummary = {
    modulesCompleted: 3,
    totalModules: 8,
    credentialsEarned: [],
    hasInProgressTrack: true,
  };

  // 5. Profile nudge candidate
  const profileNudge = makeRelationship({
    display_name: 'Sam Williams',
    stage: 'exploring',
    workos_user_id: 'user_profile',
    interaction_count: 1,
    unreplied_outreach_count: 1,
    last_addie_message_at: daysAgo(10),
    last_person_message_at: null,
  });
  const profileCaps = makeCaps({
    account_linked: true,
    profile_complete: false,
    community_profile_completeness: 15,
    slack_message_count_30d: 3,
  });

  // 6. 2-unreplied pulse
  const pulse = makeRelationship({
    display_name: 'Chris Lee',
    stage: 'welcomed',
    workos_user_id: 'user_pulse',
    interaction_count: 2,
    unreplied_outreach_count: 2,
    last_addie_message_at: daysAgo(35),
    last_person_message_at: null,
  });
  const pulseCaps = makeCaps({ account_linked: true });

  function buildCtx(
    rel: PersonRelationship,
    caps: MemberCapabilities,
    company: RelationshipContext['profile']['company'],
    msgs: RelationshipContext['recentMessages'],
    cert?: CertificationSummary | null,
    contactReason?: string,
  ): RelationshipContext {
    const engCtx: EngagementContext = {
      relationship: rel,
      capabilities: caps,
      company,
      recentMessages: msgs,
      certification: cert ?? null,
    };
    return {
      relationship: rel,
      recentMessages: msgs,
      profile: { capabilities: caps, company },
      engagementOpportunities: computeEngagementOpportunities(engCtx, contactReason),
      certification: cert ?? null,
      community: null,
    };
  }

  return [
    {
      name: '1. Ghost (company metadata only)',
      description: 'Should SKIP — no specific context to reference, only company name',
      context: buildCtx(ghost, ghostCaps,
        { name: 'Acme Digital', type: 'tech_vendor', is_member: false },
        [{
          role: 'assistant', content: 'Hey Alex! Welcome to AgenticAdvertising.org. Glad to have you here.',
          channel: 'slack', created_at: daysAgo(15),
        }]),
      channel: 'slack',
      checks: [checkShouldSkip],
    },
    {
      name: '2. Replied about WGs (Maria)',
      description: 'Should send specific follow-up about her WG interest',
      context: buildCtx(replier, replierCaps,
        { name: 'MediaLink', type: 'agency', is_member: true },
        [
          { role: 'assistant', content: 'Hey Maria! Welcome. If you\'re curious about what\'s active right now, the measurement working group just kicked off a new project.', channel: 'slack', created_at: daysAgo(10) },
          { role: 'user', content: 'That sounds interesting! I\'ve been thinking about measurement a lot lately — our clients keep asking about attention metrics vs viewability. How do I join?', channel: 'slack', created_at: daysAgo(9) },
        ]),
      channel: 'slack',
      checks: [checkShouldSend, checkUnder280, checkNoHedge, checkNoHomeworkQuestion],
    },
    {
      name: '3. Slack-active agency (James)',
      description: 'Should reference WG or Slack activity, not generic company compliment',
      context: buildCtx(slackActive, slackActiveCaps,
        { name: 'Horizon Media', type: 'agency', persona: 'media_buyer', is_member: true },
        []),
      channel: 'slack',
      checks: [checkShouldSend, checkUnder280, checkNoHedge, checkNoHomeworkQuestion],
    },
    {
      name: '4. Cert-in-progress member (Priya)',
      description: 'Should reference certification or WG work',
      context: buildCtx(certMember, certCaps,
        { name: 'The Trade Desk', type: 'tech_vendor', persona: 'dsp', is_member: true },
        [
          { role: 'assistant', content: 'Hey Priya — you\'re 3 modules into the AdCP Basics cert, nice progress.', channel: 'slack', created_at: daysAgo(35) },
          { role: 'user', content: 'Thanks! The signals module was really useful for understanding how buyer agents discover inventory.', channel: 'slack', created_at: daysAgo(20) },
        ],
        certInfo),
      channel: 'slack',
      checks: [checkShouldSend, checkUnder280, checkNoHedge, checkNoHomeworkQuestion],
    },
    {
      name: '5. Profile nudge candidate (Sam)',
      description: 'Should get a clean profile-only nudge, no other asks mixed in',
      context: buildCtx(profileNudge, profileCaps,
        { name: 'PubMatic', type: 'tech_vendor', persona: 'ssp', is_member: true },
        [
          { role: 'assistant', content: 'Hey Sam! Welcome to the community.', channel: 'slack', created_at: daysAgo(10) },
        ]),
      channel: 'slack',
      checks: [checkShouldSend, checkUnder280, checkNoHedge],
    },
    {
      name: '6. Monthly pulse (2 unreplied)',
      description: 'Should be pure value, no asks, no WG repeat',
      context: buildCtx(pulse, pulseCaps,
        { name: 'LiveRamp', type: 'tech_vendor', persona: 'data_platform', is_member: false },
        [
          { role: 'assistant', content: 'Hey Chris! Welcome. Working groups are a great way to meet people in the identity and data space.', channel: 'slack', created_at: daysAgo(60) },
          { role: 'assistant', content: 'The measurement working group just published their first set of recommendations — could be relevant to what LiveRamp is doing.', channel: 'slack', created_at: daysAgo(35) },
        ],
        null,
        'monthly pulse — low-key update'),
      channel: 'slack',
      contactReason: 'monthly pulse — low-key update',
      checks: [checkShouldSend, checkUnder280, checkNoHedge, checkNoCTA],
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const personas = buildPersonas();
  let totalChecks = 0;
  let passedChecks = 0;

  for (const persona of personas) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${persona.name}`);
    console.log(`${persona.description}`);
    console.log(`${'='.repeat(60)}`);

    const result = await composeMessage(
      persona.context,
      persona.channel,
      persona.contactReason,
    );

    const skipped = result === null;
    const text = result?.text ?? null;

    if (skipped) {
      console.log('\n  RESULT: SKIPPED (nothing meaningful to say)');
    } else {
      console.log(`\n  RESULT: SENT (${text!.length} chars)`);
      console.log(`  ---`);
      console.log(`  ${text}`);
      console.log(`  ---`);
    }

    console.log('\n  Quality checks:');
    for (const check of persona.checks) {
      totalChecks++;
      const passed = check.test(text, skipped);
      if (passed) passedChecks++;
      console.log(`    ${passed ? '✅' : '❌'} ${check.name}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: ${passedChecks}/${totalChecks} quality checks passed`);
  if (passedChecks === totalChecks) {
    console.log('✅ All checks passed!');
  } else {
    console.log(`❌ ${totalChecks - passedChecks} check(s) failed`);
  }
  console.log(`${'='.repeat(60)}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
