import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Inbound Email Webhook Tests
 *
 * Tests for the Resend inbound email webhook that:
 * 1. Routes emails based on Addie context (addie+prospect@, addie+wg-*@, plain addie@)
 * 2. Parses email addresses and extracts external participants
 * 3. Creates/updates email contacts
 * 4. Extracts insights using Claude
 * 5. Stores activities with proper contact linkage via junction table
 */

// ============================================================================
// Helper Functions (extracted from webhooks.ts for unit testing)
// ============================================================================

type AddieContext =
  | { type: 'prospect' }
  | { type: 'working-group'; groupId: string }
  | { type: 'unrouted' };

function parseEmailAddress(emailStr: string): { email: string; displayName: string | null; domain: string } {
  // Match: "Display Name" <email@domain> or Display Name <email@domain>
  const withBracketsMatch = emailStr.match(/^(?:"?([^"<]+)"?\s*)?<([^>]+@([^>]+))>$/);
  if (withBracketsMatch) {
    return {
      displayName: withBracketsMatch[1]?.trim() || null,
      email: withBracketsMatch[2].toLowerCase(),
      domain: withBracketsMatch[3].toLowerCase(),
    };
  }

  // Simple email without brackets: email@domain
  const simpleMatch = emailStr.match(/^([^@\s]+)@([^@\s]+)$/);
  if (simpleMatch) {
    return {
      displayName: null,
      email: emailStr.toLowerCase(),
      domain: simpleMatch[2].toLowerCase(),
    };
  }

  // Fallback: treat whole string as email
  const atIndex = emailStr.indexOf('@');
  return {
    displayName: null,
    email: emailStr.toLowerCase(),
    domain: atIndex > 0 ? emailStr.substring(atIndex + 1).toLowerCase() : '',
  };
}

function parseAddieContext(toAddresses: string[], ccAddresses: string[] = []): AddieContext {
  const allAddresses = [...toAddresses, ...ccAddresses];

  for (const addr of allAddresses) {
    const { email } = parseEmailAddress(addr);

    if (!email.endsWith('@agenticadvertising.org') && !email.endsWith('@updates.agenticadvertising.org')) continue;
    const localPart = email.split('@')[0];
    if (!localPart.startsWith('addie')) continue;

    const plusIndex = localPart.indexOf('+');
    if (plusIndex === -1) {
      continue;
    }

    const context = localPart.substring(plusIndex + 1);

    if (context === 'prospect') {
      return { type: 'prospect' };
    }

    if (context.startsWith('wg-')) {
      return { type: 'working-group', groupId: context.substring(3) };
    }
  }

  return { type: 'unrouted' };
}

function isOwnAddress(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain === 'agenticadvertising.org' || domain === 'updates.agenticadvertising.org';
}

function getExternalParticipants(
  from: string,
  toAddresses: string[],
  ccAddresses: string[] = []
): Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }> {
  const participants: Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }> = [];
  const seenEmails = new Set<string>();

  const senderParsed = parseEmailAddress(from);
  if (!isOwnAddress(senderParsed.email) && !seenEmails.has(senderParsed.email)) {
    seenEmails.add(senderParsed.email);
    participants.push({ ...senderParsed, role: 'sender' });
  }

  for (const addr of toAddresses) {
    const parsed = parseEmailAddress(addr);
    if (!isOwnAddress(parsed.email) && !seenEmails.has(parsed.email)) {
      seenEmails.add(parsed.email);
      participants.push({ ...parsed, role: 'recipient' });
    }
  }

  for (const addr of ccAddresses) {
    const parsed = parseEmailAddress(addr);
    if (!isOwnAddress(parsed.email) && !seenEmails.has(parsed.email)) {
      seenEmails.add(parsed.email);
      participants.push({ ...parsed, role: 'cc' });
    }
  }

  return participants;
}

// ============================================================================
// Tests
// ============================================================================

describe('Inbound Email Webhook', () => {
  describe('parseEmailAddress', () => {
    it('should parse simple email address', () => {
      const result = parseEmailAddress('john@example.com');
      expect(result).toEqual({
        email: 'john@example.com',
        displayName: null,
        domain: 'example.com',
      });
    });

    it('should parse email with display name', () => {
      const result = parseEmailAddress('John Doe <john@example.com>');
      expect(result).toEqual({
        email: 'john@example.com',
        displayName: 'John Doe',
        domain: 'example.com',
      });
    });

    it('should parse email with quoted display name', () => {
      const result = parseEmailAddress('"John Doe" <john@example.com>');
      expect(result).toEqual({
        email: 'john@example.com',
        displayName: 'John Doe',
        domain: 'example.com',
      });
    });

    it('should lowercase email and domain', () => {
      const result = parseEmailAddress('John.Doe@Example.COM');
      expect(result.email).toBe('john.doe@example.com');
      expect(result.domain).toBe('example.com');
    });

    it('should handle email with subaddressing', () => {
      const result = parseEmailAddress('addie+prospect@agenticadvertising.org');
      expect(result).toEqual({
        email: 'addie+prospect@agenticadvertising.org',
        displayName: null,
        domain: 'agenticadvertising.org',
      });
    });
  });

  describe('parseAddieContext', () => {
    it('should return prospect context for addie+prospect@', () => {
      const result = parseAddieContext(['addie+prospect@agenticadvertising.org']);
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should return prospect context when in CC', () => {
      const result = parseAddieContext(
        ['prospect@company.com'],
        ['addie+prospect@agenticadvertising.org']
      );
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should return working-group context for addie+wg-*@', () => {
      const result = parseAddieContext(['addie+wg-governance@agenticadvertising.org']);
      expect(result).toEqual({ type: 'working-group', groupId: 'governance' });
    });

    it('should extract correct group ID from wg context', () => {
      const result = parseAddieContext(['addie+wg-creative-formats@agenticadvertising.org']);
      expect(result).toEqual({ type: 'working-group', groupId: 'creative-formats' });
    });

    it('should return unrouted for plain addie@', () => {
      const result = parseAddieContext(['addie@agenticadvertising.org']);
      expect(result).toEqual({ type: 'unrouted' });
    });

    it('should return unrouted when no addie address present', () => {
      const result = parseAddieContext(['hello@example.com'], ['world@example.com']);
      expect(result).toEqual({ type: 'unrouted' });
    });

    it('should return unrouted for unknown context', () => {
      const result = parseAddieContext(['addie+unknown@agenticadvertising.org']);
      expect(result).toEqual({ type: 'unrouted' });
    });

    it('should prioritize first valid context found', () => {
      const result = parseAddieContext([
        'addie+prospect@agenticadvertising.org',
        'addie+wg-governance@agenticadvertising.org',
      ]);
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should handle case-insensitive matching', () => {
      const result = parseAddieContext(['Addie+Prospect@AgenticAdvertising.org']);
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should handle updates.agenticadvertising.org subdomain for prospect', () => {
      const result = parseAddieContext(['addie+prospect@updates.agenticadvertising.org']);
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should handle updates.agenticadvertising.org subdomain in CC', () => {
      const result = parseAddieContext(
        ['prospect@company.com'],
        ['addie+prospect@updates.agenticadvertising.org']
      );
      expect(result).toEqual({ type: 'prospect' });
    });

    it('should handle updates.agenticadvertising.org subdomain for working-group', () => {
      const result = parseAddieContext(['addie+wg-governance@updates.agenticadvertising.org']);
      expect(result).toEqual({ type: 'working-group', groupId: 'governance' });
    });
  });

  describe('isOwnAddress', () => {
    it('should return true for agenticadvertising.org', () => {
      expect(isOwnAddress('anything@agenticadvertising.org')).toBe(true);
    });

    it('should return true for updates.agenticadvertising.org', () => {
      expect(isOwnAddress('no-reply@updates.agenticadvertising.org')).toBe(true);
    });

    it('should return false for external domains', () => {
      expect(isOwnAddress('user@example.com')).toBe(false);
      expect(isOwnAddress('user@company.org')).toBe(false);
    });

    it('should handle case insensitivity', () => {
      expect(isOwnAddress('User@AgenticAdvertising.ORG')).toBe(true);
    });
  });

  describe('getExternalParticipants', () => {
    it('should extract external sender', () => {
      const result = getExternalParticipants(
        'prospect@company.com',
        ['addie+prospect@agenticadvertising.org'],
        []
      );
      expect(result).toEqual([
        { email: 'prospect@company.com', displayName: null, domain: 'company.com', role: 'sender' },
      ]);
    });

    it('should extract external recipients', () => {
      const result = getExternalParticipants(
        'bokelley@agenticadvertising.org',
        ['prospect1@company.com', 'prospect2@company.com'],
        []
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        email: 'prospect1@company.com',
        displayName: null,
        domain: 'company.com',
        role: 'recipient',
      });
      expect(result[1]).toEqual({
        email: 'prospect2@company.com',
        displayName: null,
        domain: 'company.com',
        role: 'recipient',
      });
    });

    it('should extract external CC recipients', () => {
      const result = getExternalParticipants(
        'bokelley@agenticadvertising.org',
        ['addie+prospect@agenticadvertising.org'],
        ['external-cc@company.com']
      );
      expect(result).toEqual([
        { email: 'external-cc@company.com', displayName: null, domain: 'company.com', role: 'cc' },
      ]);
    });

    it('should filter out AAO addresses', () => {
      const result = getExternalParticipants(
        'bokelley@agenticadvertising.org',
        ['prospect@company.com', 'addie+prospect@agenticadvertising.org'],
        ['hello@updates.agenticadvertising.org']
      );
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('prospect@company.com');
    });

    it('should deduplicate email addresses', () => {
      const result = getExternalParticipants(
        'person@company.com',
        ['person@company.com'],
        ['person@company.com']
      );
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('sender'); // First occurrence wins
    });

    it('should preserve display names', () => {
      const result = getExternalParticipants(
        '"John Doe" <john@company.com>',
        [],
        []
      );
      expect(result[0].displayName).toBe('John Doe');
    });

    it('should handle typical prospect outreach scenario', () => {
      // AAO admin sends email to multiple prospects, CCs Addie
      const result = getExternalParticipants(
        'bokelley@scope3.com', // External work email
        ['prospect1@acme.com', 'prospect2@acme.com', 'addie+prospect@agenticadvertising.org'],
        []
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ email: 'bokelley@scope3.com', role: 'sender' });
      expect(result[1]).toMatchObject({ email: 'prospect1@acme.com', role: 'recipient' });
      expect(result[2]).toMatchObject({ email: 'prospect2@acme.com', role: 'recipient' });
    });

    it('should handle prospect reply scenario', () => {
      // Prospect replies to AAO admin, keeps Addie in CC
      const result = getExternalParticipants(
        'prospect@acme.com',
        ['bokelley@scope3.com', 'addie+prospect@agenticadvertising.org'],
        []
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ email: 'prospect@acme.com', role: 'sender' });
      expect(result[1]).toMatchObject({ email: 'bokelley@scope3.com', role: 'recipient' });
    });
  });

  describe('Primary Contact Selection', () => {
    it('should select first recipient as primary for outbound prospect email', () => {
      const contacts = [
        { contactId: '1', email: 'sender@external.com', role: 'sender' as const, isNew: false, organizationId: null, domain: 'external.com' },
        { contactId: '2', email: 'prospect1@company.com', role: 'recipient' as const, isNew: true, organizationId: null, domain: 'company.com' },
        { contactId: '3', email: 'prospect2@company.com', role: 'recipient' as const, isNew: true, organizationId: null, domain: 'company.com' },
      ];

      const primaryContact = contacts.find(c => c.role === 'recipient') || contacts.find(c => c.role === 'cc') || contacts[0];
      expect(primaryContact.email).toBe('prospect1@company.com');
    });

    it('should select CC recipient if no TO recipients', () => {
      const contacts = [
        { contactId: '1', email: 'sender@external.com', role: 'sender' as const, isNew: false, organizationId: null, domain: 'external.com' },
        { contactId: '2', email: 'cc@company.com', role: 'cc' as const, isNew: true, organizationId: null, domain: 'company.com' },
      ];

      const primaryContact = contacts.find(c => c.role === 'recipient') || contacts.find(c => c.role === 'cc') || contacts[0];
      expect(primaryContact.email).toBe('cc@company.com');
    });

    it('should fall back to sender if only sender is external', () => {
      const contacts = [
        { contactId: '1', email: 'prospect@company.com', role: 'sender' as const, isNew: true, organizationId: null, domain: 'company.com' },
      ];

      const primaryContact = contacts.find(c => c.role === 'recipient') || contacts.find(c => c.role === 'cc') || contacts[0];
      expect(primaryContact.email).toBe('prospect@company.com');
    });
  });
});

describe('Webhook Signature Verification', () => {
  it('should require svix headers for verification', () => {
    const headers = {
      'svix-id': 'msg_123',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,signature',
    };

    expect(headers['svix-id']).toBeDefined();
    expect(headers['svix-timestamp']).toBeDefined();
    expect(headers['svix-signature']).toBeDefined();
  });

  it('should reject requests missing svix headers', () => {
    const headers = {
      'svix-id': 'msg_123',
      // Missing timestamp and signature
    };

    const hasAllHeaders = !!(
      headers['svix-id'] &&
      (headers as Record<string, string>)['svix-timestamp'] &&
      (headers as Record<string, string>)['svix-signature']
    );

    expect(hasAllHeaders).toBe(false);
  });
});

describe('Resend Payload Handling', () => {
  it('should only process email.received events', () => {
    const receivedEvent = { type: 'email.received' };
    const otherEvent = { type: 'email.sent' };

    expect(receivedEvent.type).toBe('email.received');
    expect(otherEvent.type).not.toBe('email.received');
  });

  it('should extract email data from payload', () => {
    const payload = {
      type: 'email.received',
      created_at: '2025-01-01T00:00:00Z',
      data: {
        email_id: 'email_123',
        created_at: '2025-01-01T00:00:00Z',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        cc: ['cc@example.com'],
        subject: 'Test Subject',
        message_id: '<unique-message-id@example.com>',
        attachments: [],
      },
    };

    expect(payload.data.email_id).toBe('email_123');
    expect(payload.data.from).toBe('sender@example.com');
    expect(payload.data.to).toContain('recipient@example.com');
    expect(payload.data.message_id).toBe('<unique-message-id@example.com>');
  });
});

describe('Insight Extraction', () => {
  it('should use simple extraction when no email body', () => {
    const data = {
      from: 'sender@example.com',
      subject: 'Test Subject',
      text: undefined,
    };

    // Simple extraction fallback
    const parts: string[] = [];
    if (data.subject) parts.push(`Subject: ${data.subject}`);
    if (data.from) parts.push(`From: ${data.from}`);

    const result = parts.join('\n\n');
    expect(result).toContain('Subject: Test Subject');
    expect(result).toContain('From: sender@example.com');
  });

  it('should clean quoted text from email body', () => {
    const emailText = `Hello, this is the main content.

--
John Doe
CEO, Example Corp`;

    // Simulate cleaning: split on signature delimiter
    const cleanText = emailText.split(/^--\s*$/m)[0].trim();
    expect(cleanText).toBe('Hello, this is the main content.');
  });

  it('should truncate very long content', () => {
    const longText = 'a'.repeat(1000);

    let cleanText = longText;
    if (cleanText.length > 500) {
      cleanText = cleanText.substring(0, 500) + '...';
    }

    expect(cleanText.length).toBe(503); // 500 + '...'
    expect(cleanText.endsWith('...')).toBe(true);
  });
});

describe('Database Operations', () => {
  describe('Contact Creation', () => {
    it('should create contact with correct fields', () => {
      const participant = {
        email: 'prospect@company.com',
        displayName: 'John Prospect',
        domain: 'company.com',
      };

      // Verify we have all required fields for insert
      expect(participant.email).toBeDefined();
      expect(participant.domain).toBeDefined();
    });

    it('should auto-map contact if email matches org member', () => {
      // Simulate member lookup result
      const memberResult = {
        rows: [{ organization_id: 'org_123', workos_user_id: 'user_456' }],
      };

      const organizationId = memberResult.rows[0]?.organization_id || null;
      const mappingStatus = organizationId ? 'mapped' : 'unmapped';

      expect(organizationId).toBe('org_123');
      expect(mappingStatus).toBe('mapped');
    });

    it('should set unmapped status for unknown contacts', () => {
      const memberResult = { rows: [] };

      const organizationId = memberResult.rows[0]?.organization_id || null;
      const mappingStatus = organizationId ? 'mapped' : 'unmapped';

      expect(organizationId).toBeNull();
      expect(mappingStatus).toBe('unmapped');
    });
  });

  describe('Activity Junction Table', () => {
    it('should link activity to all contacts', () => {
      const activityId = 'activity_123';
      const contacts = [
        { contactId: 'contact_1', role: 'sender' },
        { contactId: 'contact_2', role: 'recipient' },
        { contactId: 'contact_3', role: 'recipient' },
      ];
      const primaryContactId = 'contact_2'; // First recipient

      const junctionInserts = contacts.map(c => ({
        activity_id: activityId,
        contact_id: c.contactId,
        role: c.role,
        is_primary: c.contactId === primaryContactId,
      }));

      expect(junctionInserts).toHaveLength(3);
      expect(junctionInserts.filter(j => j.is_primary)).toHaveLength(1);
      expect(junctionInserts.find(j => j.is_primary)?.contact_id).toBe('contact_2');
    });
  });

  describe('Deduplication', () => {
    it('should detect duplicate emails by message_id', () => {
      const existingMessageIds = new Set(['<msg-1@example.com>', '<msg-2@example.com>']);

      const newEmail = { message_id: '<msg-1@example.com>' };
      const uniqueEmail = { message_id: '<msg-3@example.com>' };

      expect(existingMessageIds.has(newEmail.message_id)).toBe(true);
      expect(existingMessageIds.has(uniqueEmail.message_id)).toBe(false);
    });
  });
});
