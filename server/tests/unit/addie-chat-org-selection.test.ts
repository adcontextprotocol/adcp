import { beforeEach, describe, expect, it, vi } from 'vitest';

const memberContextMocks = vi.hoisted(() => ({
  getWebMemberContext: vi.fn(),
  formatMemberContextForPrompt: vi.fn(),
}));

const siMocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  formatContext: vi.fn(),
}));

vi.mock('../../src/addie/member-context.js', () => ({
  getWebMemberContext: memberContextMocks.getWebMemberContext,
  formatMemberContextForPrompt: memberContextMocks.formatMemberContextForPrompt,
}));

vi.mock('../../src/addie/services/si-retriever.js', () => ({
  siRetriever: {
    retrieve: siMocks.retrieve,
    formatContext: siMocks.formatContext,
  },
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getProgress: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { prepareRequestWithMemberTools } from '../../src/routes/addie-chat.js';

describe('prepareRequestWithMemberTools organization selection', () => {
  beforeEach(() => {
    memberContextMocks.getWebMemberContext.mockReset();
    memberContextMocks.getWebMemberContext.mockResolvedValue({
      is_mapped: false,
      is_member: false,
      slack_linked: false,
    });
    memberContextMocks.formatMemberContextForPrompt.mockReset();
    memberContextMocks.formatMemberContextForPrompt.mockReturnValue(null);
    siMocks.retrieve.mockReset();
    siMocks.retrieve.mockResolvedValue({ agents: [], retrieval_time_ms: 0 });
    siMocks.formatContext.mockReset();
  });

  it('passes the selected organization id into web member context resolution', async () => {
    await prepareRequestWithMemberTools(
      'Save this agent',
      'user_123',
      'thread_external_123',
      false,
      undefined,
      'org_selected_123',
    );

    expect(memberContextMocks.getWebMemberContext).toHaveBeenCalledWith('user_123', 'org_selected_123');
  });
});
