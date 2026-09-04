import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasEffectiveMembershipForUser: vi.fn(),
  checkAndAwardCredentials: vi.fn(),
  getCredentials: vi.fn(),
  getUserCredentials: vi.fn(),
  ensureCertifierCredential: vi.fn(),
  attemptStripeReconciliation: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  hasEffectiveMembershipForUser: mocks.hasEffectiveMembershipForUser,
  checkAndAwardCredentials: mocks.checkAndAwardCredentials,
  getCredentials: mocks.getCredentials,
  getUserCredentials: mocks.getUserCredentials,
}));

vi.mock('../../src/addie/mcp/tool-rate-limiter.js', () => ({
  checkToolRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({ stripe: {} }));

vi.mock('../../src/billing/lazy-reconcile.js', () => ({
  attemptStripeReconciliation: mocks.attemptStripeReconciliation,
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(() => ({})),
}));

vi.mock('../../src/services/certification-credential-issuance.js', () => ({
  CertifierNotConfiguredError: class extends Error {},
  CredentialNameRequiredError: class extends Error {},
  NAME_REQUIRED_MARKER: 'NAME_REQUIRED',
  ensureCertifierCredential: mocks.ensureCertifierCredential,
}));

import { createCertificationToolHandlers } from '../../src/addie/mcp/certification-tools.js';

describe('deferred certification badge membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(false);
    mocks.checkAndAwardCredentials.mockResolvedValue([]);
    mocks.getCredentials.mockResolvedValue([{
      id: 'practitioner',
      name: 'AdCP Practitioner',
      tier: 2,
      certifier_group_id: 'group_paid',
    }]);
    mocks.getUserCredentials.mockResolvedValue([{
      credential_id: 'practitioner',
      certifier_credential_id: null,
      awarded_at: new Date().toISOString(),
    }]);
    mocks.attemptStripeReconciliation.mockResolvedValue({
      healed: false,
      reason: 'no_stripe_customer',
    });
  });

  it('does not issue a recently deferred paid badge after membership ends', async () => {
    const handlers = createCertificationToolHandlers({
      is_member: true,
      workos_user: {
        workos_user_id: 'user_lapsed',
        email: 'learner@example.test',
      },
    } as any);

    const result = await handlers.get('check_credentials')?.({});

    expect(result).toContain('No new credentials to issue');
    expect(mocks.hasEffectiveMembershipForUser).toHaveBeenCalledWith('user_lapsed');
    expect(mocks.ensureCertifierCredential).not.toHaveBeenCalled();
  });

  it('lazy-heals a Stripe-active member before issuing a deferred paid badge', async () => {
    mocks.hasEffectiveMembershipForUser
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mocks.attemptStripeReconciliation.mockResolvedValue({
      healed: true,
      reason: 'healed_from_stripe',
      subscriptionStatus: 'active',
    });
    mocks.ensureCertifierCredential.mockResolvedValue({
      credentialId: 'certifier-credential-id',
      publicId: 'certifier-public-id',
      badgeUrl: 'https://badge.example.test/practitioner',
      outcome: 'issued',
    });
    const handlers = createCertificationToolHandlers({
      is_member: false,
      workos_user: {
        workos_user_id: 'user_healed',
        email: 'learner@example.test',
      },
      organization: {
        workos_organization_id: 'org_healed',
        is_personal: false,
      },
    } as any);

    const result = await handlers.get('check_credentials')?.({});

    expect(mocks.attemptStripeReconciliation).toHaveBeenCalledWith(
      'org_healed',
      expect.any(Object),
    );
    expect(mocks.ensureCertifierCredential).toHaveBeenCalledWith({
      userId: 'user_healed',
      credentialId: 'practitioner',
    });
    expect(result).toContain('Credential earned: AdCP Practitioner!');
  });

  it('returns a LinkedIn profile link when an earned credential has no external badge configured', async () => {
    mocks.checkAndAwardCredentials.mockResolvedValue(['decision_makers']);
    mocks.getCredentials.mockResolvedValue([{
      id: 'decision_makers',
      name: 'AdCP for Decision-Makers',
      tier: 1,
      certifier_group_id: null,
    }]);
    mocks.getUserCredentials.mockResolvedValue([]);

    const handlers = createCertificationToolHandlers({
      is_member: false,
      workos_user: {
        workos_user_id: 'user_decision_maker',
        email: 'learner@example.test',
        first_name: 'Test',
        last_name: 'Learner',
      },
    } as any);

    const result = await handlers.get('check_credentials')?.({});

    expect(result).toContain('Credential earned: AdCP for Decision-Makers!');
    expect(result).toContain('[Add to LinkedIn profile](https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME');
    expect(result).toContain('&name=AdCP%20for%20Decision-Makers');
    expect(result).not.toContain('&certId=');
    expect(mocks.ensureCertifierCredential).not.toHaveBeenCalled();
  });

  it('renders links for an older credential with no Certifier group', async () => {
    const awardedAt = '2026-08-01T00:00:00.000Z';
    mocks.getCredentials.mockResolvedValue([{
      id: 'decision_makers',
      name: 'AdCP for Decision-Makers',
      tier: 1,
      certifier_group_id: null,
    }]);
    mocks.getUserCredentials.mockResolvedValue([{
      credential_id: 'decision_makers',
      certifier_credential_id: null,
      certifier_public_id: null,
      awarded_at: awardedAt,
    }]);

    const handlers = createCertificationToolHandlers({
      is_member: false,
      workos_user: {
        workos_user_id: 'user_decision_maker',
        email: 'learner@example.test',
      },
    } as any);

    const result = await handlers.get('check_credentials')?.({});

    expect(result).toContain('Credential earned: AdCP for Decision-Makers!');
    expect(result).toContain('[Add to LinkedIn profile](https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME');
    expect(result).toContain('&issueYear=2026&issueMonth=8');
    expect(mocks.ensureCertifierCredential).not.toHaveBeenCalled();
  });

  it('does not retry an older configured credential while still rendering its links', async () => {
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(true);
    mocks.getUserCredentials.mockResolvedValue([{
      credential_id: 'practitioner',
      certifier_credential_id: null,
      certifier_public_id: null,
      awarded_at: '2026-08-01T00:00:00.000Z',
    }]);

    const handlers = createCertificationToolHandlers({
      is_member: true,
      workos_user: {
        workos_user_id: 'user_lapsed',
        email: 'learner@example.test',
      },
    } as any);

    const result = await handlers.get('check_credentials')?.({});

    expect(result).toContain('Credential earned: AdCP Practitioner!');
    expect(result).toContain('[Add to LinkedIn profile]');
    expect(mocks.ensureCertifierCredential).not.toHaveBeenCalled();
  });
});
