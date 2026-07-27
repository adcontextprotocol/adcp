import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  resolveName: vi.fn(),
  isConfigured: vi.fn(),
  createDraft: vi.fn(),
  getCredential: vi.fn(),
  issueDraft: vi.fn(),
  sendCredential: vi.fn(),
  getBadge: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getClient: vi.fn(async () => ({ query: mocks.query, release: mocks.release })),
}));

vi.mock('../../src/utils/resolve-user-name.js', () => ({
  resolveUserNameWithFallbacks: mocks.resolveName,
}));

vi.mock('../../src/services/certifier-client.js', () => ({
  buildRecipientName: (user: { first_name?: string | null; last_name?: string | null; email: string }) =>
    `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email,
  createCredentialDraft: mocks.createDraft,
  getCredential: mocks.getCredential,
  getCredentialBadgeUrl: mocks.getBadge,
  isCertifierConfigured: mocks.isConfigured,
  issueCredentialDraft: mocks.issueDraft,
  sendCredential: mocks.sendCredential,
}));

import {
  CredentialNameRequiredError,
  CredentialRecoveryConflictError,
  credentialExpiryDate,
  ensureCertifierCredential,
} from '../../src/services/certification-credential-issuance.js';

const awardedRow = {
  first_name: 'Test',
  last_name: 'Learner',
  email: 'learner@test.example',
  credential_name: 'AdCP Specialist — Signals',
  tier: 3,
  certifier_group_id: 'group_signals',
  certifier_credential_id: null,
  certifier_public_id: null,
  certifier_badge_url: null,
  certifier_issuance_key: null,
  certifier_issuance_state: 'not_started' as const,
  certifier_delivery_state: 'not_started' as const,
};

function setDbRow(row = awardedRow) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_credentials uc')) return { rows: [row], rowCount: 1 };
    if (sql.includes('UPDATE user_credentials')) return { rows: [{ id: 'award_1' }], rowCount: 1 };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

describe('certification credential issuance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isConfigured.mockReturnValue(true);
    mocks.resolveName.mockResolvedValue({ firstName: 'Test', lastName: 'Learner' });
    mocks.createDraft.mockResolvedValue({
      id: 'cert_new', publicId: 'public_new', groupId: 'group_signals', status: 'draft',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    mocks.issueDraft.mockResolvedValue({
      id: 'cert_new', publicId: 'public_new', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    mocks.sendCredential.mockResolvedValue({
      id: 'cert_new', publicId: 'public_new', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    mocks.getBadge.mockResolvedValue('https://cdn.test/badge.png');
    setDbRow();
  });

  it('serializes, persists a draft, then issues and sends with canonical expiry', async () => {
    const result = await ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
      now: new Date('2026-07-27T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      outcome: 'issued',
      credentialId: 'cert_new',
      publicId: 'public_new',
      badgeUrl: 'https://cdn.test/badge.png',
      emailDelivery: 'sent',
    });
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group_signals',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
      expiryDate: '2028-07-27',
    }));
    expect(mocks.issueDraft).toHaveBeenCalledWith('cert_new');
    expect(mocks.sendCredential).toHaveBeenCalledWith('cert_new');
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('certifier_credential_id IS NULL'))).toBe(true);
  });

  it('gates issuance when no real first name can be resolved', async () => {
    mocks.resolveName.mockResolvedValue({ firstName: null, lastName: null });

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toBeInstanceOf(CredentialNameRequiredError);

    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.issueDraft).not.toHaveBeenCalled();
  });

  it('does not resend an already-issued credential while repairing its badge', async () => {
    setDbRow({
      ...awardedRow,
      certifier_credential_id: 'cert_existing',
      certifier_public_id: 'public_existing',
      certifier_issuance_state: 'issued',
      certifier_delivery_state: 'unknown',
    });
    mocks.getCredential.mockResolvedValue({
      id: 'cert_existing', publicId: 'public_existing', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });

    const result = await ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    });

    expect(result.outcome).toBe('badge_refreshed');
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.issueDraft).not.toHaveBeenCalled();
    expect(mocks.sendCredential).not.toHaveBeenCalled();
  });

  it('retains the external mapping when badge lookup fails', async () => {
    mocks.getBadge.mockRejectedValue(new Error('badge rendering pending'));

    const result = await ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    });

    expect(result).toMatchObject({ outcome: 'issued', credentialId: 'cert_new', badgeUrl: null });
    const providerUpdate = mocks.query.mock.calls.find(([sql]) =>
      sql.includes('certifier_badge_url = COALESCE'));
    expect(providerUpdate?.[1]).toEqual([
      'user_learner', 'specialist_signals', 'cert_new', 'public_new', null,
    ]);
  });

  it('refuses to attach an existing external credential from another group', async () => {
    setDbRow({
      ...awardedRow,
      certifier_credential_id: 'cert_wrong',
      certifier_issuance_state: 'issued',
      certifier_delivery_state: 'unknown',
    });
    mocks.getCredential.mockResolvedValue({
      id: 'cert_wrong', publicId: 'public_wrong', groupId: 'group_other', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toBeInstanceOf(CredentialRecoveryConflictError);
  });

  it('returns an in-progress conflict instead of waiting for the advisory lock', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toThrow('already in progress');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('does not create again when a prior draft creation needs reconciliation', async () => {
    setDbRow({
      ...awardedRow,
      certifier_issuance_key: '00000000-0000-4000-8000-000000000001',
      certifier_issuance_state: 'reconcile_required',
    });

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toThrow('manual reconciliation');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('resumes a persisted draft without creating a second credential', async () => {
    setDbRow({
      ...awardedRow,
      certifier_credential_id: 'cert_draft',
      certifier_issuance_key: '00000000-0000-4000-8000-000000000002',
      certifier_issuance_state: 'draft_created',
    });
    mocks.getCredential.mockResolvedValue({
      id: 'cert_draft', publicId: 'public_draft', groupId: 'group_signals', status: 'draft',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    mocks.issueDraft.mockResolvedValue({
      id: 'cert_draft', publicId: 'public_draft', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    mocks.sendCredential.mockResolvedValue({
      id: 'cert_draft', publicId: 'public_draft', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });

    await ensureCertifierCredential({ userId: 'user_learner', credentialId: 'specialist_signals' });

    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.issueDraft).toHaveBeenCalledWith('cert_draft');
    expect(mocks.sendCredential).toHaveBeenCalledWith('cert_draft');
  });

  it('marks an ambiguous draft-creation failure for reconciliation before retry', async () => {
    mocks.createDraft.mockRejectedValue(new Error('provider timeout'));

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toThrow('provider timeout');

    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("certifier_issuance_state = 'reconcile_required'"))).toBe(true);
  });

  it('refuses an existing credential belonging to a different recipient', async () => {
    setDbRow({
      ...awardedRow,
      certifier_credential_id: 'cert_other_recipient',
      certifier_issuance_state: 'issued',
      certifier_delivery_state: 'unknown',
    });
    mocks.getCredential.mockResolvedValue({
      id: 'cert_other_recipient', publicId: 'public_other', groupId: 'group_signals', status: 'issued',
      recipient: { name: 'Other Learner', email: 'other@test.example' },
    });

    await expect(ensureCertifierCredential({
      userId: 'user_learner',
      credentialId: 'specialist_signals',
    })).rejects.toThrow('different recipient');
  });

  it('omits expiry for tier-one credentials', () => {
    expect(credentialExpiryDate(1, new Date('2026-07-27T12:00:00.000Z'))).toBeUndefined();
  });
});
