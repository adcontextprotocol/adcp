import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
}));

vi.hoisted(() => {
  process.env.CERTIFIER_API_TOKEN = 'certifier_test_token';
});

vi.mock('axios', () => ({
  default: { create: mocks.create },
}));

import { createCredentialDraft } from '../../src/services/certifier-client.js';

describe('Certifier client timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReturnValue({ post: mocks.post });
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
});
