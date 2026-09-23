import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gemini: vi.fn(), sonnet: vi.fn(), prepare: vi.fn(), addMessage: vi.fn(), sendEmail: vi.fn(),
  thread: { thread_id: 'email-thread', external_id: 'email:original', user_id: 'sam@example.test' },
}));
vi.mock('../../../src/addie/thread-service.js', () => ({ getThreadService: () => ({
  countRecentEmailMessages: vi.fn().mockResolvedValue(0),
  findThreadByEmailMessageId: vi.fn(async () => mocks.thread),
  getThreadMessages: vi.fn().mockResolvedValue([{ role: 'assistant', content: 'Earlier email response.' }]),
  addMessage: mocks.addMessage,
}) }));
vi.mock('../../../src/notifications/email.js', () => ({ sendEmailReply: mocks.sendEmail, SLACK_INVITE_URL: 'https://example.test/slack' }));
vi.mock('../../../src/routes/addie-chat.js', () => ({
  prepareRequestWithMemberTools: mocks.prepare,
  buildTieredAccess: (requestTools: unknown) => ({ requestTools,
    processOptions: { maxIterations: 5, modelOverride: 'legacy-anonymous-model' } }),
  getChatClaudeClient: async () => ({ processMessage: mocks.sonnet, getRegisteredTools: () => ['list_members'],
    forkForGeminiDirect: () => ({ processMessage: mocks.gemini }) }),
}));
import { handleEmailConversation } from '../../../src/addie/email-conversation-handler.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ADDIE_RESPONSE_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'unused');
  vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'false');
  mocks.prepare.mockResolvedValue({ messageToProcess: 'Explain AdCP', requestContext: 'Anonymous context',
    requestTools: { tools: [], handlers: new Map() } });
  mocks.sendEmail.mockResolvedValue({ success: true, messageId: 'reply-id' });
});
afterEach(() => vi.unstubAllEnvs());
const input = { emailId: 'inbound', messageId: 'email-id', from: 'sam@example.test', to: ['addie@example.test'],
  subject: 'AdCP help', textContent: 'Explain AdCP', addieAddress: 'addie@example.test', addiePosition: 'to' as const,
  inReplyTo: 'earlier-id', senderEmail: 'sam@example.test', senderWorkosUserId: 'untrusted-user' };

describe('Email response policy integration', () => {
  it.each(['gemini', 'sonnet'])('continues email threads on %s without trusting spoofable identity', async provider => {
    vi.stubEnv('ADDIE_RESPONSE_PROVIDER', provider);
    const model = provider === 'gemini' ? 'gemini-3.7-flash' : 'claude-sonnet-5';
    const model_execution = { source: 'provider', requested_provider: provider === 'gemini' ? 'google' : 'anthropic',
      requested_model: model, provider: provider === 'gemini' ? 'google' : 'anthropic', model, model_resolution: 'exact', fallback_reason: null };
    const selected = provider === 'gemini' ? mocks.gemini : mocks.sonnet;
    selected.mockResolvedValue({ text: 'Email answer.', tools_used: [], tool_executions: [], model_execution });
    expect(await handleEmailConversation(input)).toMatchObject({ responded: true, threadId: 'email-thread' });
    expect(mocks.prepare).toHaveBeenCalledWith('Explain AdCP', undefined, 'email:original', false, 'email-thread');
    expect(selected.mock.calls[0][4]).toMatchObject({ modelOverride: model, maxIterations: 5,
      costScope: { userId: expect.stringMatching(/^email:[a-f0-9]{16}$/), tier: 'anonymous' }, reserveSideEffect: expect.any(Function) });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', model_execution, email_message_id: 'reply-id' }));
    expect(provider === 'gemini' ? mocks.sonnet : mocks.gemini).not.toHaveBeenCalled();
  });

  it('does not send an email or use Sonnet when Gemini is unavailable and fallback is disabled', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    expect(await handleEmailConversation(input)).toMatchObject({ responded: false });
    expect(mocks.sonnet).not.toHaveBeenCalled(); expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
