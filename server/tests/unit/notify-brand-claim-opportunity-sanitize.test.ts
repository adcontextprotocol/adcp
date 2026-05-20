/**
 * Pin: notifyBrandClaimOpportunity neutralizes Slack mrkdwn meta-
 * characters in user-controlled fields (user name, email, brand name,
 * verified-owner-org name) before posting to a moderator-trusted
 * channel. Same threat model as #4754's pending-logo sanitizer — the
 * data here flows from signup form fields and the discovered-brand
 * table, which are externally influenced.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_TEST_SIGNUP_OPS';
});

const mocks = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(),
  isSlackConfigured: vi.fn(() => true),
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mocks.sendChannelMessage(...args),
  isSlackConfigured: () => mocks.isSlackConfigured(),
}));

import { notifyBrandClaimOpportunity } from '../../src/notifications/registry.js';

function lastSentJSON(): string {
  const call = mocks.sendChannelMessage.mock.calls.at(-1);
  expect(call).toBeDefined();
  const [, message] = call!;
  return JSON.stringify(message);
}

describe('notifyBrandClaimOpportunity mrkdwn sanitization', () => {
  beforeEach(() => {
    mocks.sendChannelMessage.mockReset();
    mocks.sendChannelMessage.mockResolvedValue({ ts: '1779200000.000' });
    mocks.isSlackConfigured.mockReturnValue(true);
  });

  it('neutralizes broadcast tokens in first_name / last_name', async () => {
    await notifyBrandClaimOpportunity({
      user_email: 'alice@scope3.com',
      user_first_name: 'Alice <!channel>',
      user_last_name: '<!here>',
      domain: 'scope3.com',
      brand_name: 'Scope3',
      brand_view_url: '/brand/view/scope3.com',
      brand_already_verified: false,
    });
    const json = lastSentJSON();
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<!here>');
  });

  it('strips link-label-breakout characters from brand_name', async () => {
    await notifyBrandClaimOpportunity({
      user_email: 'alice@scope3.com',
      domain: 'scope3.com',
      brand_name: 'Scope3|<https://evil/|legit>',
      brand_view_url: '/brand/view/scope3.com',
      brand_already_verified: false,
    });
    const json = lastSentJSON();
    // Link-label sanitizer drops `|`, `<`, `>` so the brand_name cannot
    // break out of the <url|label> link.
    expect(json).not.toContain('|<');
    expect(json).not.toContain('|legit>');
  });

  it('sanitizes verified_owner_org_name when present', async () => {
    await notifyBrandClaimOpportunity({
      user_email: 'alice@scope3.com',
      domain: 'scope3.com',
      brand_name: 'Scope3',
      brand_view_url: '/brand/view/scope3.com',
      brand_already_verified: true,
      verified_owner_org_name: 'Acme <!channel>',
    });
    const json = lastSentJSON();
    expect(json).not.toContain('<!channel>');
  });

  it('preserves benign content', async () => {
    await notifyBrandClaimOpportunity({
      user_email: 'alice@scope3.com',
      user_first_name: 'Alice',
      user_last_name: 'Park',
      domain: 'scope3.com',
      brand_name: 'Scope3',
      brand_view_url: '/brand/view/scope3.com',
      brand_already_verified: false,
    });
    const json = lastSentJSON();
    expect(json).toContain('Alice Park');
    expect(json).toContain('alice@scope3.com');
  });
});
