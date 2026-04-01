import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import type { MemberContext } from '../../server/src/addie/member-context.js';

// --- Shared mock state ---
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
};

// Track what createBillingToolHandlers was called with
let billingHandlersCalledWith: unknown[] = [];

// --- Mock modules (must be before imports) ---
jest.mock('../../server/src/addie/claude-client.js', () => ({
  AddieClaudeClient: jest.fn().mockImplementation(() => ({
    processMessage: jest.fn<any>().mockResolvedValue({
      text: 'Here is your payment link.',
      tools_used: ['create_payment_link'],
      flagged: false,
    }),
  })),
}));

jest.mock('../../server/src/addie/security.js', () => ({
  sanitizeInput: jest.fn().mockImplementation((input: string) => ({
    sanitized: input,
    flagged: false,
  })),
  validateOutput: jest.fn().mockImplementation((input: string) => ({
    sanitized: input,
    flagged: false,
  })),
  generateInteractionId: jest.fn().mockReturnValue('test-interaction-id'),
}));

jest.mock('../../server/src/addie/member-context.js', () => ({
  getWebMemberContext: jest.fn<any>().mockResolvedValue(mockMemberContext),
  formatMemberContextForPrompt: jest.fn().mockReturnValue('Member context summary'),
}));

jest.mock('../../server/src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: jest.fn<any>().mockResolvedValue(false),
  ADMIN_TOOLS: [],
  createAdminToolHandlers: jest.fn().mockReturnValue(new Map()),
}));

jest.mock('../../server/src/addie/mcp/member-tools.js', () => ({
  MEMBER_TOOLS: [],
  createMemberToolHandlers: jest.fn().mockReturnValue(new Map()),
}));

jest.mock('../../server/src/addie/mcp/billing-tools.js', () => ({
  BILLING_TOOLS: [],
  createBillingToolHandlers: jest.fn<any>().mockImplementation((...args: unknown[]) => {
    billingHandlersCalledWith = args;
    return new Map();
  }),
}));

jest.mock('../../server/src/notifications/email.js', () => ({
  sendEmailReply: jest.fn<any>().mockResolvedValue({ success: true, messageId: 'msg_123' }),
}));

jest.mock('../../server/src/db/addie-db.js', () => ({
  AddieDatabase: jest.fn().mockImplementation(() => ({
    logInteraction: jest.fn<any>().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../server/src/config/models.js', () => ({
  AddieModelConfig: { chat: 'claude-sonnet-4-20250514' },
}));

jest.mock('../../server/src/utils/markdown.js', () => ({
  markdownToEmailHtml: jest.fn().mockImplementation((md: string) => `<p>${md}</p>`),
}));

jest.mock('../../server/src/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }),
}));

describe('email-handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    billingHandlersCalledWith = [];
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
      expect(billingHandlersCalledWith).toHaveLength(1);
      expect(billingHandlersCalledWith[0]).toEqual(mockMemberContext);
    });
  });
});
