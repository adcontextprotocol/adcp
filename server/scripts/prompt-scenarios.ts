/**
 * Manual scenarios for inspecting suggested-prompts output.
 * Run: npx tsx server/scripts/prompt-scenarios.ts
 */
import { buildSuggestedPrompts } from '../src/addie/home/builders/suggested-prompts.js';
import type { MemberContext } from '../src/addie/member-context.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW - d * DAY);

function show(name: string, ctx: MemberContext | null, isAdmin = false) {
  const prompts = buildSuggestedPrompts(ctx, isAdmin);
  console.log(`\n--- ${name} ---`);
  if (prompts.length === 0) {
    console.log('  (no prompts)');
    return;
  }
  prompts.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`));
}

const base = (over: Partial<MemberContext> = {}): MemberContext => ({
  is_mapped: true,
  is_member: true,
  slack_linked: true,
  workos_user: { workos_user_id: 'u1', email: 'x@y.co' },
  organization: {
    workos_organization_id: 'o1',
    name: 'Acme',
    subscription_status: 'active',
    is_personal: false,
    membership_tier: 'company_standard',
  },
  working_groups: [{ name: 'Protocol', is_leader: false }],
  engagement: { login_count_30d: 10, last_login: ago(1), working_group_count: 1, email_click_count_30d: 0, interest_level: 'high' },
  addie_history: { total_interactions: 20, last_interaction_at: ago(1), recent_topics: [] },
  ...over,
} as MemberContext);

show('Anonymous (unlinked)', { is_mapped: false, is_member: false, slack_linked: false } as MemberContext);
show('Null context', null);
show('Admin (any user, isAdmin=true)', base(), true);
show('Linked but not member', base({ is_member: false }));
show('Healthy member, has WG, no persona', base());
show('Healthy member with data_decoder persona', base({
  persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
}));
show('Pragmatic builder persona', base({
  persona: { persona: 'pragmatic_builder', aspiration_persona: null, source: 'assessment', journey_stage: null },
}));
show('Lapsed member (60d no login)', base({
  engagement: { login_count_30d: 0, last_login: ago(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
}));
show('Low-login active (1 login, 5d ago)', base({
  engagement: { login_count_30d: 1, last_login: ago(5), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
}));
show('Profile incomplete (30%)', base({
  community_profile: { is_public: false, slug: null, completeness: 30, github_username: null },
}));
show('Solo Explorer-tier owner', base({
  organization: { workos_organization_id: 'o1', name: 'Acme', subscription_status: 'active', is_personal: true, membership_tier: 'individual_academic' },
  org_membership: { role: 'owner', member_count: 1, joined_at: ago(60) },
}));
show('Owner of 5-person team, Builder tier, profile incomplete', base({
  org_membership: { role: 'owner', member_count: 5, joined_at: ago(120) },
  community_profile: { is_public: false, slug: null, completeness: 50, github_username: null },
}));
show('Owner of company without a public listing', base({
  org_membership: { role: 'owner', member_count: 3, joined_at: ago(60) },
  adoption: { has_company_listing: false, team_wg_coverage: 0.5 },
}));
show('Owner of 8-person team with low WG coverage', base({
  org_membership: { role: 'owner', member_count: 8, joined_at: ago(180) },
  adoption: { has_company_listing: true, team_wg_coverage: 0.1 },
}));
show('WG leader (Creative)', base({
  working_groups: [{ name: 'Creative', is_leader: true }],
}));
show('No working groups', base({ working_groups: [] }));
show('Compound: lapsed Explorer owner, persona, no WG, incomplete profile', base({
  organization: { workos_organization_id: 'o1', name: 'Acme', subscription_status: 'active', is_personal: true, membership_tier: 'individual_academic' },
  org_membership: { role: 'owner', member_count: 1, joined_at: ago(120) },
  community_profile: { is_public: false, slug: null, completeness: 20, github_username: null },
  working_groups: [],
  persona: { persona: 'data_decoder', aspiration_persona: null, source: 'assessment', journey_stage: null },
  engagement: { login_count_30d: 0, last_login: ago(60), working_group_count: 0, email_click_count_30d: 0, interest_level: null },
}));
show('Brand new member, day 2, no persona', base({
  working_groups: [],
  community_profile: { is_public: false, slug: null, completeness: 10, github_username: null },
  addie_history: { total_interactions: 0, last_interaction_at: null, recent_topics: [] },
  org_membership: { role: 'owner', member_count: 1, joined_at: ago(2) },
  engagement: { login_count_30d: 2, last_login: ago(1), working_group_count: 0, email_click_count_30d: 0, interest_level: 'high' },
}));
