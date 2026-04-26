import type { MemberContext } from '../../../member-context.js';
import type { PromptRule, PromptRuleContext } from './types.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isMapped(ctx: MemberContext | null): boolean {
  return !!ctx?.workos_user?.workos_user_id;
}

function isMember(ctx: MemberContext | null): boolean {
  return !!ctx?.is_member;
}

/**
 * True for users who can act on org-level setup (owner or admin in WorkOS).
 * Day-to-day org operations at most companies are run by admins, not the
 * original owner — gating only on 'owner' would miss them.
 */
function isOrgOperator(ctx: MemberContext | null): boolean {
  const role = ctx?.org_membership?.role;
  return role === 'owner' || role === 'admin';
}

function isLinkedNonMember(ctx: MemberContext | null): boolean {
  return isMapped(ctx) && !isMember(ctx);
}

function persona(ctx: MemberContext | null): string | null {
  return ctx?.persona?.persona ?? null;
}

function lastLoginMs(ctx: MemberContext | null): number | null {
  const last = ctx?.engagement?.last_login;
  return last ? new Date(last).getTime() : null;
}

function isLapsed(ctx: MemberContext | null): boolean {
  const last = lastLoginMs(ctx);
  if (last === null) return false;
  const sinceLogin = Date.now() - last;
  // Re-engage for 30–90 days. Past that, the user is dormant and the prompt
  // becomes nagging rather than helpful.
  return sinceLogin > THIRTY_DAYS_MS && sinceLogin < 3 * THIRTY_DAYS_MS;
}

function isLowLoginActive(ctx: MemberContext | null): boolean {
  const last = lastLoginMs(ctx);
  if (last === null) return false;
  const lapsed = Date.now() - last > THIRTY_DAYS_MS;
  if (lapsed) return false;
  if ((ctx?.engagement?.login_count_30d ?? 0) >= 3) return false;
  // Suppress for brand-new members — they haven't been around long enough to
  // have missed anything.
  const joined = ctx?.org_membership?.joined_at;
  if (joined) {
    const joinedMs = new Date(joined).getTime();
    if (Date.now() - joinedMs < 14 * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

export const ADMIN_RULES: PromptRule[] = [
  {
    id: 'admin.pending_invoices',
    priority: 110,
    when: ({ isAdmin }) => isAdmin,
    label: 'Pending invoices',
    prompt: 'Show me all organizations with pending invoices',
  },
  {
    id: 'admin.lookup_company',
    priority: 109,
    when: ({ isAdmin }) => isAdmin,
    label: 'Look up a company',
    prompt: 'What is the membership status for [company name]?',
  },
  {
    id: 'admin.prospect_pipeline',
    priority: 108,
    when: ({ isAdmin }) => isAdmin,
    label: 'Prospect pipeline',
    prompt: 'Show me the current prospect pipeline',
  },
  {
    id: 'admin.my_working_groups',
    priority: 107,
    when: ({ isAdmin }) => isAdmin,
    label: 'My working groups',
    prompt: "What's happening in my working groups?",
  },
];

export const MEMBER_RULES: PromptRule[] = [
  {
    id: 'discovery.what_is_adcp',
    priority: 100,
    when: ({ memberContext }) => !isMember(memberContext),
    label: "What's AdCP?",
    prompt: 'Give me the short version of AdCP.',
  },
  {
    id: 'discovery.what_brings_you',
    priority: 95,
    when: ({ memberContext }) => !isMember(memberContext),
    label: 'New here',
    prompt: 'I just landed here — what is this place?',
  },
  {
    id: 'engagement.lapsed',
    priority: 92,
    when: ({ memberContext }) => isMember(memberContext) && isLapsed(memberContext),
    label: "What's new since you were last here?",
    prompt: "What's happened at AgenticAdvertising.org since I last checked in?",
  },
  {
    id: 'discovery.how_to_join',
    priority: 90,
    when: ({ memberContext }) => !isMember(memberContext),
    label: 'Join AgenticAdvertising.org',
    prompt: 'How do I join, and what do I get?',
  },
  // Persona rules use decay: false because they're not nudges — they're
  // a stable entry point reflecting who the user is. Suppressing them
  // would leave the user with strictly worse fallbacks for their persona.
  {
    id: 'persona.molecule_builder',
    priority: 90,
    decay: false,
    when: ({ memberContext }) =>
      isMember(memberContext) && persona(memberContext) === 'molecule_builder',
    label: 'Build a sales agent',
    prompt: 'Walk me through setting up a sales agent on AdCP.',
  },
  {
    id: 'persona.pragmatic_builder',
    priority: 90,
    decay: false,
    when: ({ memberContext }) =>
      isMember(memberContext) && persona(memberContext) === 'pragmatic_builder',
    label: 'Fastest path to AdCP',
    prompt: "What's the fastest way to plug AdCP into what I already have?",
  },
  {
    id: 'persona.data_decoder',
    priority: 90,
    decay: false,
    when: ({ memberContext }) => isMember(memberContext) && persona(memberContext) === 'data_decoder',
    label: 'Prove the outcomes',
    prompt: 'How do I measure agentic vs. traditional and prove AdCP improves outcomes?',
  },
  {
    id: 'persona.resops_integrator',
    priority: 90,
    decay: false,
    when: ({ memberContext }) =>
      isMember(memberContext) && persona(memberContext) === 'resops_integrator',
    label: 'Fit AdCP into my stack',
    prompt: 'Where does AdCP sit next to my SSP, DSP, and data tools?',
  },
  {
    id: 'persona.ladder_or_simple_starter',
    priority: 90,
    decay: false,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      (persona(memberContext) === 'ladder_climber' ||
        persona(memberContext) === 'simple_starter'),
    label: 'Start with the Academy',
    prompt: 'Which Academy module should I start with?',
  },
  {
    id: 'persona.pureblood_protector',
    priority: 90,
    decay: false,
    when: ({ memberContext }) =>
      isMember(memberContext) && persona(memberContext) === 'pureblood_protector',
    label: 'Brand safety controls',
    prompt: 'How do I keep my brand off the wrong inventory with AdCP?',
  },
  {
    id: 'membership.linked_not_member',
    priority: 85,
    when: ({ memberContext }) => isLinkedNonMember(memberContext),
    label: 'Membership options',
    prompt: 'What membership tiers are available?',
  },
  {
    id: 'tier.explorer_upgrade',
    priority: 85,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      memberContext?.organization?.membership_tier === 'individual_academic',
    label: 'Upgrade for Slack & working group access',
    prompt: 'What do I get if I upgrade from Explorer?',
  },
  {
    id: 'profile.incomplete',
    priority: 80,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      (memberContext?.community_profile?.completeness ?? 100) < 80,
    label: 'Complete my profile',
    prompt: 'Help me complete my community profile.',
  },
  {
    id: 'org.owner_solo_invite_team',
    priority: 78,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      memberContext?.org_membership?.role === 'owner' &&
      memberContext?.org_membership?.member_count === 1,
    label: 'Invite your team',
    prompt: 'Help me invite my team to the organization.',
  },
  {
    id: 'org.owner_set_company_listing',
    priority: 76,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      isOrgOperator(memberContext) &&
      memberContext?.organization?.is_personal === false &&
      memberContext?.adoption?.has_company_listing === false,
    label: 'List my company in the directory',
    prompt: 'Help me add my company to the directory.',
  },
  {
    id: 'org.owner_team_wg_coverage_low',
    priority: 73,
    when: ({ memberContext }) => {
      if (!isMember(memberContext)) return false;
      if (!isOrgOperator(memberContext)) return false;
      // Fire for any team of 3+ where less than half are in working groups.
      // Below 3 people, coverage math is too noisy to act on.
      if ((memberContext?.org_membership?.member_count ?? 0) < 3) return false;
      const coverage = memberContext?.adoption?.team_wg_coverage;
      return (coverage ?? 1) < 0.5;
    },
    label: 'Find working groups for my team',
    prompt: 'Which working groups should my team join?',
  },
  {
    id: 'wg.find_groups',
    priority: 75,
    when: ({ memberContext }) =>
      isMember(memberContext) && (memberContext?.working_groups?.length ?? 0) === 0,
    label: 'Find a working group',
    prompt: 'What working groups would be relevant for my work?',
  },
  {
    id: 'wg.leader_todos',
    priority: 72,
    when: ({ memberContext }) =>
      isMember(memberContext) &&
      (memberContext?.working_groups ?? []).some((g) => g.is_leader),
    label: 'Working group to-dos',
    prompt: 'What needs my attention in the working groups I lead?',
  },
  {
    id: 'wg.member_updates',
    priority: 70,
    when: ({ memberContext }) => {
      if (!isMember(memberContext)) return false;
      const groups = memberContext?.working_groups ?? [];
      return groups.length > 0 && !groups.some((g) => g.is_leader);
    },
    label: "What's happening in my working groups?",
    prompt: 'Catch me up on my working groups.',
  },
  {
    id: 'engagement.low_login_active',
    priority: 58,
    when: ({ memberContext }) => isMember(memberContext) && isLowLoginActive(memberContext),
    label: "Here's what you missed",
    prompt: "Give me a quick catch-up on what's happened recently.",
  },
  {
    id: 'member.test_my_agent',
    priority: 50,
    when: ({ memberContext }) => isMember(memberContext),
    label: 'Test my agent',
    prompt: 'Can you check if my agent is set up correctly?',
  },
  {
    id: 'addie.few_interactions',
    priority: 40,
    when: ({ memberContext }) =>
      (memberContext?.addie_history?.total_interactions ?? 0) < 3 && !!memberContext,
    label: 'What can you help me with?',
    prompt: 'What kinds of things can I ask you about?',
  },
  {
    id: 'member.help_post',
    priority: 30,
    when: ({ memberContext }) => isMember(memberContext),
    label: 'Help me post something',
    prompt: 'Anything I should be posting about this week?',
  },
  {
    id: 'fallback.whats_new',
    priority: 10,
    when: () => true,
    label: "What's new?",
    prompt: "What's new at AgenticAdvertising.org?",
  },
];

export const ALL_RULES: PromptRule[] = [...ADMIN_RULES, ...MEMBER_RULES];
