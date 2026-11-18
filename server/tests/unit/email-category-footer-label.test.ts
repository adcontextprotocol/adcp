import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
  },
}));
vi.mock('../../src/db/email-db.js', () => ({
  emailDb: {
    createEmailEvent: vi.fn(async () => ({ tracking_id: 'trk' })),
    markEmailSent: vi.fn(async () => undefined),
    hasEmailBeenSent: vi.fn(async () => false),
  },
  EmailDatabase: class {},
}));
vi.mock('../../src/db/email-preferences-db.js', () => ({
  emailPrefsDb: {
    getOrCreateUserPreferences: vi.fn(async () => ({ unsubscribe_token: 'unsub-token' })),
    shouldSendEmail: vi.fn(async () => true),
  },
  EmailPreferencesDatabase: class {},
}));

describe('email footer category label', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'id' }, error: null });
    process.env.RESEND_API_KEY = 'test_key';
  });

  it('maps known category ids to reader-facing names', async () => {
    const { formatEmailCategoryLabel } = await import('../../src/notifications/email.js');
    expect(formatEmailCategoryLabel('the_prompt')).toBe('The Prompt');
    expect(formatEmailCategoryLabel('the_build')).toBe('The Build');
    expect(formatEmailCategoryLabel('working_groups')).toBe('working group updates');
  });

  it('keeps labels that are already text and humanizes unknown ids', async () => {
    const { formatEmailCategoryLabel } = await import('../../src/notifications/email.js');
    expect(formatEmailCategoryLabel('community updates')).toBe('community updates');
    expect(formatEmailCategoryLabel('some_new_category')).toBe('some new category');
    expect(formatEmailCategoryLabel(undefined)).toBeUndefined();
  });

  it('The Prompt footer reads "Unsubscribe from The Prompt" in HTML and text', async () => {
    const { sendMarketingEmail } = await import('../../src/notifications/email.js');
    await sendMarketingEmail({
      to: 'reader@example.test',
      subject: 'The Prompt',
      htmlContent: '<p>Body</p>',
      textContent: 'Body',
      category: 'the_prompt',
      workosUserId: 'user_1',
    });
    const sent = mockSend.mock.calls[0][0] as { html: string; text: string };
    expect(sent.html).toMatch(/Unsubscribe<\/a>\s+from The Prompt/);
    expect(sent.html).not.toContain('the_prompt');
    expect(sent.text).toContain('Unsubscribe from The Prompt:');
  });
});
