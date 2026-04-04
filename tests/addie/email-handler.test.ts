import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { MemberContext } from '../../server/src/addie/member-context.js';

const { mockMemberContext, state } = vi.hoisted(() => {
  const mockMemberContext: MemberContext = {
    is_mapped: true,
    is_member: true,
    slack_linked: false,
    organization: {
      workos_organization_id: 'org_test_123',
      name: 'Responsible Media Ltd',
      subscription_status: null,
      is_personal: false,
    },
    workos_user: {
      workos_user_id: 'user_emily_123',
      email: 'emily@responsiblem.com',
      first_name: 'Emily',
      last_name: 'Roberts',
    },
  } as MemberContext;
  return { mockMemberContext, state: { billingHandlersCalledWith: [] as unknown[] } };
});

// --- Mock modules (must be before imports) ---
vi.mock('../../server/src/addie/claude-client.js', () => ({
  AddieClaudeClient: vi.fn().mockImplementation(function () {
    return {
      processMessage: vi.fn<any>().mockResolvedValue({
        text: 'Here is your payment link.',
        tools_used: ['create_payment_link'],
        flagged: false,
      }),
    };
  }),
}));

vi.mock('../../server/src/addie/security.js', () => ({
  sanitizeInput: vi.fn().mockImplementation((input: string) => ({
    sanitized: input,
    flagged: false,
  })),
  validateOutput: vi.fn().mockImplementation((input: string) => ({
    sanitized: input,
    flagged: false,
  })),
  generateInteractionId: vi.fn().mockReturnValue('test-interaction-id'),
}));

vi.mock('../../server/src/addie/member-context.js', () => ({
  getWebMemberContext: vi.fn<any>().mockResolvedValue(mockMemberContext),
  formatMemberContextForPrompt: vi.fn().mockReturnValue('Member context summary'),
}));

vi.mock('../../server/src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: vi.fn<any>().mockResolvedValue(false),
  ADMIN_TOOLS: [],
  createAdminToolHandlers: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('../../server/src/addie/mcp/member-tools.js', () => ({
  MEMBER_TOOLS: [],
  createMemberToolHandlers: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('../../server/src/addie/mcp/billing-tools.js', () => ({
  BILLING_TOOLS: [],
  createBillingToolHandlers: vi.fn<any>().mockImplementation((...args: unknown[]) => {
    state.billingHandlersCalledWith = args;
    return new Map();
  }),
}));

vi.mock('../../server/src/notifications/email.js', () => ({
  sendEmailReply: vi.fn<any>().mockResolvedValue({ success: true, messageId: 'msg_123' }),
}));

vi.mock('../../server/src/db/addie-db.js', () => ({
  AddieDatabase: vi.fn().mockImplementation(function () {
    return { logInteraction: vi.fn<any>().mockResolvedValue(undefined) };
  }),
}));

vi.mock('../../server/src/config/models.js', () => ({
  AddieModelConfig: { chat: 'claude-sonnet-4-20250514' },
}));

vi.mock('../../server/src/utils/markdown.js', () => ({
  markdownToEmailHtml: vi.fn().mockImplementation((md: string) => `<p>${md}</p>`),
}));

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

describe('email-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.billingHandlersCalledWith = [];
  });

  describe('handleEmailInvocation', () => {
    test('passes member context to billing tool handlers', async () => {
      const { initializeEmailHandler, handleEmailInvocation } = await import(
        '../../server/src/addie/email-handler.js'
      );

      // Set ANTHROPIC_API_KEY so initialization succeeds
      process.env.ADDIE_ANTHROPIC_API_KEY = 'test-key';
      initializeEmailHandler();

      await handleEmailInvocation(
        {
          emailId: 'email_123',
          messageId: 'msg_123',
          from: 'emily@responsiblem.com',
          to: ['addie@agenticadvertising.org'],
          subject: 'Membership purchase',
          textContent: 'Addie, please send a payment link for the Individual membership',
          addieAddress: 'addie@agenticadvertising.org',
        },
        'user_emily_123'
      );

      // The key assertion: createBillingToolHandlers must receive the member context,
      // not be called with no arguments (which was the bug)
      expect(state.billingHandlersCalledWith).toHaveLength(1);
      expect(state.billingHandlersCalledWith[0]).toEqual(mockMemberContext);
    });
  });
});
