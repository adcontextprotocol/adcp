import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
  isAxiosError: vi.fn(),
}));

vi.hoisted(() => {
  process.env.CERTIFIER_API_TOKEN = 'certifier_test_token';
});

vi.mock('axios', () => ({
  default: { create: mocks.create, isAxiosError: mocks.isAxiosError },
}));

import {
  createCredentialDraft,
  isDefinitiveCertifierNonDelivery,
} from '../../src/services/certifier-client.js';

describe('Certifier client timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReturnValue({ post: mocks.post });
    mocks.isAxiosError.mockImplementation((error: unknown) =>
      typeof error === 'object' && error !== null && 'isAxiosError' in error);
    mocks.post.mockResolvedValue({
      data: {
        id: 'cert_draft',
        publicId: 'public_draft',
        groupId: 'group_test',
        status: 'draft',
        recipient: { name: 'Test Learner', email: 'learner@test.example' },
      },
    });
  });

  it('bounds external calls while a credential recovery lock is held', async () => {
    await createCredentialDraft({
      groupId: 'group_test',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }));
  });

  it('only treats 4xx and pre-dispatch connection failures as definitive non-delivery', () => {
    expect(isDefinitiveCertifierNonDelivery({
      isAxiosError: true,
      response: { status: 400 },
    })).toBe(true);
    expect(isDefinitiveCertifierNonDelivery({
      isAxiosError: true,
      response: { status: 503 },
    })).toBe(false);
    expect(isDefinitiveCertifierNonDelivery({
      isAxiosError: true,
      code: 'ECONNREFUSED',
    })).toBe(true);
    expect(isDefinitiveCertifierNonDelivery({
      isAxiosError: true,
      code: 'ECONNABORTED',
    })).toBe(false);
    expect(isDefinitiveCertifierNonDelivery({
      isAxiosError: true,
      code: 'ECONNRESET',
    })).toBe(false);
  });
});
