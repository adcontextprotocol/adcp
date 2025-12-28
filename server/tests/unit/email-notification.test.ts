import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock send function we can inspect
const mockSend = vi.fn();

// Mock resend before importing the module - needs to be a proper class
vi.mock('resend', () => {
  return {
    Resend: class MockResend {
      emails = {
        send: mockSend,
      };
    },
  };
});

// Mock the database
const mockCreateEmailEvent = vi.fn();
const mockMarkEmailSent = vi.fn();
const mockHasEmailBeenSent = vi.fn();

vi.mock('../../src/db/email-db.js', () => {
  return {
    emailDb: {
      createEmailEvent: mockCreateEmailEvent,
      markEmailSent: mockMarkEmailSent,
      hasEmailBeenSent: mockHasEmailBeenSent,
    },
    EmailDatabase: class MockEmailDatabase {},
  };
});

// Mock email preferences database
const mockGetOrCreateUserPreferences = vi.fn();
const mockShouldSendEmail = vi.fn();

vi.mock('../../src/db/email-preferences-db.js', () => {
  return {
    emailPrefsDb: {
      getOrCreateUserPreferences: mockGetOrCreateUserPreferences,
      shouldSendEmail: mockShouldSendEmail,
    },
    EmailPreferencesDatabase: class MockEmailPreferencesDatabase {},
  };
});

describe('Email Notifications', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockCreateEmailEvent.mockReset();
    mockMarkEmailSent.mockReset();
    mockHasEmailBeenSent.mockReset();
    mockGetOrCreateUserPreferences.mockReset();
    mockShouldSendEmail.mockReset();

    mockSend.mockResolvedValue({ data: { id: 'test-email-id' }, error: null });
    mockCreateEmailEvent.mockResolvedValue({ tracking_id: 'test-tracking-id' });
    mockMarkEmailSent.mockResolvedValue(undefined);
    mockHasEmailBeenSent.mockResolvedValue(false);
    mockGetOrCreateUserPreferences.mockResolvedValue({ unsubscribe_token: 'test-unsub-token' });
    mockShouldSendEmail.mockResolvedValue(true);

    process.env = { ...originalEnv, RESEND_API_KEY: 'test_api_key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('sendWelcomeEmail', () => {
    it('should send welcome email with correct parameters', async () => {
      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      const result = await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Test Org',
        productName: 'Professional Plan',
      });

      expect(result).toBe(true);
      expect(mockCreateEmailEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          email_type: 'welcome_member',
          recipient_email: 'test@example.com',
        })
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          subject: 'Welcome to AgenticAdvertising.org!',
          from: expect.stringContaining('hello@updates.agenticadvertising.org'),
        })
      );
      expect(mockMarkEmailSent).toHaveBeenCalledWith('test-tracking-id', 'test-email-id');
    });

    it('should include organization name in email body', async () => {
      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Acme Corp',
      });

      const sendCall = mockSend.mock.calls[0]?.[0];
      expect(sendCall?.html).toContain('Acme Corp');
      expect(sendCall?.text).toContain('Acme Corp');
    });

    it('should include tracked URLs in email', async () => {
      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Test Org',
      });

      const sendCall = mockSend.mock.calls[0]?.[0];
      // Tracked URLs contain the tracking ID and redirect info
      expect(sendCall?.html).toContain('/r/test-tracking-id');
      expect(sendCall?.html).toContain('cta_dashboard');
    });

    it('should return false when Resend API key is not configured', async () => {
      // Reset and import without API key
      vi.resetModules();
      process.env = { ...originalEnv };
      delete process.env.RESEND_API_KEY;

      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      const result = await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Test Org',
      });

      expect(result).toBe(false);
    });

    it('should return false when send fails with error', async () => {
      mockSend.mockResolvedValue({
        data: null,
        error: { message: 'Invalid API key' },
      });

      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      const result = await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Test Org',
      });

      expect(result).toBe(false);
    });

    it('should return false when send throws exception', async () => {
      mockSend.mockRejectedValue(new Error('Network error'));

      const { sendWelcomeEmail } = await import('../../src/notifications/email.js');

      const result = await sendWelcomeEmail({
        to: 'test@example.com',
        organizationName: 'Test Org',
      });

      expect(result).toBe(false);
    });
  });

  describe('sendUserSignupEmail', () => {
    it('should send email with member content for users with active subscription', async () => {
      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        firstName: 'John',
        organizationName: 'Acme Corp',
        hasActiveSubscription: true,
      });

      expect(result).toBe(true);
      const sendCall = mockSend.mock.calls[0]?.[0];
      expect(sendCall?.subject).toContain('Acme Corp');
      expect(sendCall?.subject).toContain('AgenticAdvertising.org');
      expect(sendCall?.html).toContain('Hi John,');
      expect(sendCall?.html).toContain('already a member!');
      expect(sendCall?.html).toContain('Invite Teammates');
    });

    it('should send email with non-member content for users without subscription', async () => {
      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        firstName: 'Jane',
        organizationName: 'Startup Inc',
        hasActiveSubscription: false,
      });

      expect(result).toBe(true);
      const sendCall = mockSend.mock.calls[0]?.[0];
      expect(sendCall?.subject).toBe('Welcome to AgenticAdvertising.org');
      expect(sendCall?.html).toContain('Hi Jane,');
      expect(sendCall?.html).toContain("isn't a member yet");
      expect(sendCall?.html).toContain('Become a Member');
    });

    it('should handle missing firstName gracefully', async () => {
      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        hasActiveSubscription: false,
      });

      expect(result).toBe(true);
      const sendCall = mockSend.mock.calls[0]?.[0];
      expect(sendCall?.html).toContain('Hi there,');
    });

    it('should skip sending if email already sent to user', async () => {
      mockHasEmailBeenSent.mockResolvedValue(true);

      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        hasActiveSubscription: true,
        workosUserId: 'user_123',
      });

      // Should return true (success) but not actually send
      expect(result).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should track email type based on subscription status', async () => {
      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      // Member email
      await sendUserSignupEmail({
        to: 'member@example.com',
        hasActiveSubscription: true,
      });

      expect(mockCreateEmailEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          email_type: 'signup_user_member',
        })
      );

      // Reset mocks
      mockCreateEmailEvent.mockClear();
      mockSend.mockClear();
      vi.resetModules();

      // Re-import to get fresh module
      const { sendUserSignupEmail: sendEmail2 } = await import('../../src/notifications/email.js');

      // Non-member email
      await sendEmail2({
        to: 'nonmember@example.com',
        hasActiveSubscription: false,
      });

      expect(mockCreateEmailEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          email_type: 'signup_user_nonmember',
        })
      );
    });

    it('should return false when Resend API key is not configured', async () => {
      vi.resetModules();
      process.env = { ...originalEnv };
      delete process.env.RESEND_API_KEY;

      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        hasActiveSubscription: true,
      });

      expect(result).toBe(false);
    });

    it('should return false when send fails', async () => {
      mockSend.mockResolvedValue({
        data: null,
        error: { message: 'Send failed' },
      });

      const { sendUserSignupEmail } = await import('../../src/notifications/email.js');

      const result = await sendUserSignupEmail({
        to: 'test@example.com',
        hasActiveSubscription: true,
      });

      expect(result).toBe(false);
    });
  });

  describe('hasSignupEmailBeenSent', () => {
    it('should return true if member signup email was sent', async () => {
      mockHasEmailBeenSent.mockImplementation(({ email_type }) => {
        return Promise.resolve(email_type === 'signup_user_member');
      });

      const { hasSignupEmailBeenSent } = await import('../../src/notifications/email.js');

      const result = await hasSignupEmailBeenSent('user_123');
      expect(result).toBe(true);
    });

    it('should return true if non-member signup email was sent', async () => {
      mockHasEmailBeenSent.mockImplementation(({ email_type }) => {
        return Promise.resolve(email_type === 'signup_user_nonmember');
      });

      const { hasSignupEmailBeenSent } = await import('../../src/notifications/email.js');

      const result = await hasSignupEmailBeenSent('user_123');
      expect(result).toBe(true);
    });

    it('should return false if no signup email was sent', async () => {
      mockHasEmailBeenSent.mockResolvedValue(false);

      const { hasSignupEmailBeenSent } = await import('../../src/notifications/email.js');

      const result = await hasSignupEmailBeenSent('user_123');
      expect(result).toBe(false);
    });
  });
});
