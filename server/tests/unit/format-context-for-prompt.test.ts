import { describe, it, expect } from 'vitest';
import {
  formatContextForPrompt,
  type RelationshipContext,
} from '../../src/addie/services/relationship-context.js';
import type { PersonRelationship } from '../../src/db/relationship-db.js';

function fixtureRelationship(overrides: Partial<PersonRelationship> = {}): PersonRelationship {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slack_user_id: 'U0FAKE001',
    workos_user_id: 'user_fake_001',
    email: 'tej@example.com',
    prospect_org_id: null,
    display_name: 'Tej Test',
    stage: 'participating',
    stage_changed_at: new Date('2026-01-01T00:00:00Z'),
    last_addie_message_at: new Date('2026-04-29T10:00:00Z'),
    last_person_message_at: new Date('2026-04-29T10:30:00Z'),
    last_interaction_channel: 'slack',
    next_contact_after: null,
    contact_preference: null,
    slack_dm_channel_id: null,
    slack_dm_thread_ts: null,
    sentiment_trend: 'positive',
    interaction_count: 12,
    unreplied_outreach_count: 0,
    opted_out: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-04-29T10:30:00Z'),
    ...overrides,
  } as PersonRelationship;
}

function fixtureContext(overrides: Partial<RelationshipContext> = {}): RelationshipContext {
  return {
    relationship: fixtureRelationship(),
    recentMessages: [],
    profile: {
      capabilities: null,
      company: null,
    },
    certification: null,
    journey: undefined,
    community: undefined,
    identity: { account_linked: true, has_slack: true, has_email: true },
    preferences: {
      contact_preference: null,
      opted_out: false,
      marketing_opt_in: null,
    },
    invites: [],
    recentThreads: [],
    orgMemberships: [],
    ...overrides,
  };
}

describe('formatContextForPrompt — new memory sections', () => {
  it('renders Account linked inline in the header', () => {
    const out = formatContextForPrompt(fixtureContext());
    expect(out).toContain('**Account linked**: Yes');
  });

  it('renders Account linked: No when account not linked', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        identity: { account_linked: false, has_slack: true, has_email: true },
      })
    );
    expect(out).toContain('**Account linked**: No');
  });

  it('omits Preferences section when no signals are set', () => {
    const out = formatContextForPrompt(fixtureContext());
    expect(out).not.toContain('### Preferences');
  });

  it('renders Preferences with opted_out warning when opted out', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        preferences: { contact_preference: null, opted_out: true, marketing_opt_in: null },
      })
    );
    expect(out).toContain('### Preferences');
    expect(out).toContain('Opted out');
    expect(out).toContain('do not contact');
  });

  it('renders contact_preference and marketing_opt_in when set', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        preferences: {
          contact_preference: 'slack',
          opted_out: false,
          marketing_opt_in: true,
        },
      })
    );
    expect(out).toContain('### Preferences');
    expect(out).toContain('Preferred channel: slack');
    expect(out).toContain('Marketing opt-in: yes');
    expect(out).not.toContain('Opted out');
  });

  it('omits Open invites section when no invites', () => {
    const out = formatContextForPrompt(fixtureContext());
    expect(out).not.toContain('### Open membership invites');
  });

  it('renders Open invites with status and relative expiry', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        invites: [
          {
            org_id: 'org_pubx',
            org_name: 'Pubx',
            lookup_key: 'aao_membership_professional',
            status: 'pending',
            created_at: new Date(Date.now() - 86400000 * 2),
            expires_at: new Date(Date.now() + 86400000 * 12),
            invited_by_user_id: 'user_admin',
          },
          {
            org_id: 'org_pubx',
            org_name: 'Pubx',
            lookup_key: 'aao_membership_professional',
            status: 'expired',
            created_at: new Date(Date.now() - 86400000 * 30),
            expires_at: new Date(Date.now() - 86400000 * 3),
            invited_by_user_id: 'user_admin',
          },
        ],
      })
    );
    expect(out).toContain('### Open membership invites');
    expect(out).toContain('[pending] aao_membership_professional at Pubx — expires in 12 days');
    expect(out).toContain('[expired] aao_membership_professional at Pubx — expires 3 days ago');
  });

  it('omits Recent threads section when empty', () => {
    const out = formatContextForPrompt(fixtureContext());
    expect(out).not.toContain('### Recent threads');
  });

  it('renders Recent threads with title, channel, and last_active', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        recentThreads: [
          {
            thread_id: 'thr1',
            channel: 'slack',
            title: 'colleague invitations',
            message_count: 4,
            last_message_at: new Date(Date.now() - 86400000),
            created_at: new Date(Date.now() - 86400000 * 5),
          },
          {
            thread_id: 'thr2',
            channel: 'web',
            title: null,
            message_count: 1,
            last_message_at: new Date(Date.now() - 86400000 * 4),
            created_at: new Date(Date.now() - 86400000 * 4),
          },
        ],
      })
    );
    expect(out).toContain('### Recent threads');
    expect(out).toContain('[slack] "colleague invitations" — 4 messages, last 1 day ago');
    // Untitled thread renders without the title clause; pluralization respects count.
    expect(out).toContain('[web] — 1 message, last 4 days ago');
  });

  it('uses org_id when org_name is null', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        invites: [
          {
            org_id: 'org_no_name',
            org_name: null,
            lookup_key: 'aao_membership_professional',
            status: 'pending',
            created_at: new Date(),
            expires_at: new Date(Date.now() + 86400000 * 5),
            invited_by_user_id: 'user_admin',
          },
        ],
      })
    );
    expect(out).toContain('aao_membership_professional at org_no_name');
  });

  it('omits Org memberships for a single-org member with no special signals', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        orgMemberships: [
          {
            workos_organization_id: 'org_only',
            org_name: 'Solo Co',
            role: 'member',
            seat_type: 'contributor',
            provisioning_source: 'webhook',
            is_paying_member: true,
            joined_at: new Date('2026-01-01'),
          },
        ],
      })
    );
    // Single org with no admin role / community-only seat / verified-domain
    // signal — covered by the existing Company line in the header, no need
    // for a separate section.
    expect(out).not.toContain('### Org memberships');
  });

  it('renders Org memberships when the person belongs to multiple WorkOS orgs', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        orgMemberships: [
          {
            workos_organization_id: 'org_a',
            org_name: 'Acme',
            role: 'admin',
            seat_type: 'contributor',
            provisioning_source: 'verified_domain',
            is_paying_member: true,
            joined_at: new Date('2026-01-01'),
          },
          {
            workos_organization_id: 'org_b',
            org_name: 'Other Co',
            role: 'member',
            seat_type: 'community_only',
            provisioning_source: 'invited',
            is_paying_member: false,
            joined_at: new Date('2026-04-01'),
          },
        ],
      })
    );
    expect(out).toContain('### Org memberships');
    expect(out).toContain('Acme');
    expect(out).toContain('admin');
    expect(out).toContain('community-only seat');
    expect(out).toContain('via verified_domain');
    expect(out).toContain('paying');
  });

  it('renders Org memberships even with single org when role/seat/provisioning warrants it', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        orgMemberships: [
          {
            workos_organization_id: 'org_solo_admin',
            org_name: 'Solo Admin Co',
            role: 'admin',
            seat_type: 'contributor',
            provisioning_source: 'webhook',
            is_paying_member: true,
            joined_at: new Date('2026-01-01'),
          },
        ],
      })
    );
    expect(out).toContain('### Org memberships');
    expect(out).toContain('Solo Admin Co');
  });

  it('renders all four new sections together for a fully-populated person', () => {
    const out = formatContextForPrompt(
      fixtureContext({
        preferences: {
          contact_preference: 'slack',
          opted_out: false,
          marketing_opt_in: true,
        },
        invites: [
          {
            org_id: 'org_pubx',
            org_name: 'Pubx',
            lookup_key: 'aao_membership_professional',
            status: 'pending',
            created_at: new Date(Date.now() - 86400000),
            expires_at: new Date(Date.now() + 86400000 * 14),
            invited_by_user_id: 'user_admin',
          },
        ],
        recentThreads: [
          {
            thread_id: 'thr1',
            channel: 'slack',
            title: 'colleague invitations',
            message_count: 4,
            last_message_at: new Date(Date.now() - 86400000),
            created_at: new Date(Date.now() - 86400000 * 2),
          },
        ],
      })
    );
    expect(out).toContain('**Account linked**: Yes');
    expect(out).toContain('### Preferences');
    expect(out).toContain('### Open membership invites');
    expect(out).toContain('### Recent threads');
  });
});
