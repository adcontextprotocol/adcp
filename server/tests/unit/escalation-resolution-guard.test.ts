import { describe, expect, it, vi } from 'vitest';
import {
  extractEscalationDomains,
  extractEscalationAgentUrls,
  guardEscalationResolution,
  isRegistrySetupEscalation,
} from '../../src/services/escalation-resolution-guard.js';
import type { Escalation } from '../../src/db/escalation-db.js';

function escalation(overrides: Partial<Escalation>): Escalation {
  return {
    id: 1,
    thread_id: null,
    message_id: null,
    slack_user_id: null,
    workos_user_id: null,
    user_display_name: null,
    user_email: null,
    user_slack_handle: null,
    category: 'needs_human_action',
    priority: 'normal',
    summary: 'Registry propagation failure for latinxctv.com',
    original_request: null,
    addie_context: null,
    notification_channel_id: null,
    notification_sent_at: null,
    notification_message_ts: null,
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    resolution_notes: null,
    perspective_id: null,
    perspective_slug: null,
    github_issue_url: null,
    github_issue_number: null,
    github_issue_repo: null,
    dedup_key: null,
    sla_admin_last_notified_at: null,
    sla_requester_last_notified_at: null,
    sla_follow_up_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('escalation-resolution-guard', () => {
  it('identifies registry setup escalations and extracts base domains from agent URLs', () => {
    const esc = escalation({
      summary: 'save_agent blocked for https://sales.latinxctv.com/mcp',
      addie_context: 'registry still returns member:null for latinxctv.com; tracked at https://github.com/adcontextprotocol/adcp/issues/5709',
    });

    expect(isRegistrySetupEscalation(esc)).toBe(true);
    expect(extractEscalationDomains(esc)).toEqual(['latinxctv.com']);
    expect(extractEscalationAgentUrls(esc)).toEqual(['https://sales.latinxctv.com/mcp']);
  });

  it('does not guard non-registry escalations', async () => {
    const pool = { query: vi.fn() };
    const result = await guardEscalationResolution({
      escalation: escalation({ summary: 'Please update event title', addie_context: null }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result).toEqual({ ok: true, checked: false });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('blocks resolved when a referenced domain is missing locally', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [] }) };

    const result = await guardEscalationResolution({
      escalation: escalation({
        summary: 'Registry propagation failure for latinxctv.com',
        addie_context: 'member:null and save_agent blocked',
      }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers[0].type).toBe('missing_local_domain');
      expect(result.blockers[0].domain).toBe('latinxctv.com');
    }
  });

  it('blocks resolved when the domain is attached to an unverified personal workspace', async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            domain: 'latinxctv.com',
            workos_organization_id: 'org_personal',
            organization_name: 'Gustavo Workspace',
            is_personal: true,
            verified: false,
            member_status: 'member',
            subscription_status: 'active',
          },
        ],
      }),
    };

    const result = await guardEscalationResolution({
      escalation: escalation({
        summary: 'Domain verification and save_agent blocked for latinxctv.com',
        addie_context: 'registry returns member:null',
      }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.map((b) => b.type).sort()).toEqual([
        'personal_workspace_domain',
        'unverified_local_domain',
      ]);
    }
  });

  it('blocks resolved when verified local domain has no member profile', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              domain: 'latinxctv.com',
              workos_organization_id: 'org_company',
              organization_name: 'LatinxCTV',
              is_personal: false,
              verified: true,
              member_status: 'member',
              subscription_status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await guardEscalationResolution({
      escalation: escalation({
        summary: 'Registry member:null for latinxctv.com',
      }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers[0].type).toBe('missing_member_profile');
      expect(result.blockers[0].message).toContain('member:null');
    }
  });

  it('allows resolved when verified company domain has member profile and agent hostname is covered', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              domain: 'latinxctv.com',
              workos_organization_id: 'org_company',
              organization_name: 'LatinxCTV',
              is_personal: false,
              verified: true,
              member_status: 'member',
              subscription_status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'profile_1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              workos_organization_id: 'org_company',
              domain: 'latinxctv.com',
            },
          ],
        }),
    };

    const result = await guardEscalationResolution({
      escalation: escalation({
        summary: 'save_agent now unblocked for https://sales.latinxctv.com/mcp',
        addie_context: 'registry no longer returns member:null for latinxctv.com',
      }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result).toEqual({ ok: true, checked: true });
  });

  it('blocks resolved when agent hostname is not covered by the verified company domain', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              domain: 'latinxctv.com',
              workos_organization_id: 'org_company',
              organization_name: 'LatinxCTV',
              is_personal: false,
              verified: true,
              member_status: 'member',
              subscription_status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'profile_1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              workos_organization_id: 'org_company',
              domain: 'latinxctv.com',
            },
          ],
        }),
    };

    const result = await guardEscalationResolution({
      escalation: escalation({
        summary: 'save_agent blocked for https://sales.other-domain.com/mcp',
        addie_context: 'registry member:null for latinxctv.com',
      }),
      status: 'resolved',
      pool: pool as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.map((b) => b.type)).toContain('agent_hostname_not_verified');
    }
  });

  it('allows wont_do for suspicious registry requests', async () => {
    const pool = { query: vi.fn() };
    const result = await guardEscalationResolution({
      escalation: escalation({ summary: 'Registry propagation failure for latinxctv.com' }),
      status: 'wont_do',
      pool: pool as any,
    });

    expect(result).toEqual({ ok: true, checked: false });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
