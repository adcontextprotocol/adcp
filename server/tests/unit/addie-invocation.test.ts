import { describe, it, expect } from 'vitest';

/**
 * Addie Email Invocation Detection Tests
 *
 * Tests the logic that determines when Addie should respond to emails.
 * These are pure functions extracted from email-handler.ts to avoid
 * import-time dependencies on WorkOS/etc.
 */

// ============================================================================
// Pure functions extracted from email-handler.ts for testing
// ============================================================================

const ADDIE_INVOCATION_PATTERNS = [
  // Direct requests: "Addie, can/could/please/would..."
  /\b@?addie[,:]?\s+(?:can|could|please|would)\b/i,
  // Greetings with request intent: "Hey Addie, can you..." or "Hi Addie please..."
  /\b(?:hey|hi)\s+addie[,:]?\s+(?:can|could|please|would|send|help|create|get|find|look|check|tell|show|make|give|do)\b/i,
  // Ask pattern: "ask Addie to..." or "asking Addie to..."
  /\bask(?:ing)?\s+addie\s+(?:to|about|for)\b/i,
  // Imperative with Addie: "Addie send..." or "Addie, help..."
  /\b@?addie[,:]?\s+(?:send|help|create|get|find|look|check|tell|show|make|give|do|schedule|draft|write|prepare|forward)\b/i,
];

function stripQuotedContent(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const cleanLines: string[] = [];

  for (const line of lines) {
    // Stop at standard quote/forward markers
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line.trim())) break;
    if (/^-{5,}\s*Original Message\s*-{5,}$/i.test(line.trim())) break;
    if (/^From:\s+.+$/i.test(line.trim()) && cleanLines.length > 0) break;  // "From:" mid-email indicates forwarded content
    if (/^Begin forwarded message:$/i.test(line.trim())) break;
    if (line.trim() === '--') break;  // Signature divider

    // Skip lines that are quoted (start with >)
    if (/^>+\s*/.test(line)) continue;

    cleanLines.push(line);
  }

  return cleanLines.join('\n').trim();
}

function detectAddieInvocation(text: string): { invoked: boolean; request?: string } {
  if (!text) return { invoked: false };

  // Strip quoted content to only check the new message
  const cleanText = stripQuotedContent(text);

  if (!cleanText) return { invoked: false };

  // Check each pattern against cleaned text (no quoted content)
  for (const pattern of ADDIE_INVOCATION_PATTERNS) {
    const match = cleanText.match(pattern);
    if (match) {
      // Extract the request - everything after the invocation on the same line
      // or the next few sentences
      const startIndex = (match.index || 0) + match[0].length;
      const afterInvocation = cleanText.substring(startIndex);

      // Take up to 500 chars or until we hit a signature/quote marker
      const endMarkers = ['\n--', '\nOn ', '\nFrom:', '\n>', '\nSent from'];
      let endIndex = afterInvocation.length;

      for (const marker of endMarkers) {
        const markerIndex = afterInvocation.indexOf(marker);
        if (markerIndex !== -1 && markerIndex < endIndex) {
          endIndex = markerIndex;
        }
      }

      const request = afterInvocation.substring(0, Math.min(endIndex, 500)).trim();

      return { invoked: true, request };
    }
  }

  return { invoked: false };
}

// ============================================================================
// Tests
// ============================================================================

describe('detectAddieInvocation', () => {
  describe('explicit request patterns - should trigger', () => {
    it('should detect "Addie, can you..." pattern', () => {
      const result = detectAddieInvocation('Addie, can you send the invoice?');
      expect(result.invoked).toBe(true);
      expect(result.request).toContain('you send the invoice');
    });

    it('should detect "Addie please..." pattern', () => {
      const result = detectAddieInvocation('Addie please send a payment link');
      expect(result.invoked).toBe(true);
    });

    it('should detect "@Addie could you..." pattern', () => {
      const result = detectAddieInvocation('@Addie could you help with this?');
      expect(result.invoked).toBe(true);
    });

    it('should detect "Hey Addie, send..." pattern', () => {
      const result = detectAddieInvocation('Hey Addie, send them the pricing doc');
      expect(result.invoked).toBe(true);
    });

    it('should detect "Hi Addie can you..." pattern', () => {
      const result = detectAddieInvocation('Hi Addie can you help?');
      expect(result.invoked).toBe(true);
    });

    it('should detect "ask Addie to..." pattern', () => {
      const result = detectAddieInvocation('Let me ask Addie to send the invoice');
      expect(result.invoked).toBe(true);
    });

    it('should detect "ask Addie about..." pattern', () => {
      const result = detectAddieInvocation('Let me ask Addie about pricing');
      expect(result.invoked).toBe(true);
    });

    it('should detect "Addie send..." imperative pattern', () => {
      const result = detectAddieInvocation('Addie send the invoice to them');
      expect(result.invoked).toBe(true);
    });

    it('should detect "Addie, help..." pattern', () => {
      const result = detectAddieInvocation('Addie, help me draft a response');
      expect(result.invoked).toBe(true);
    });

    it('should be case insensitive', () => {
      const result = detectAddieInvocation('ADDIE, PLEASE send the invoice');
      expect(result.invoked).toBe(true);
    });
  });

  describe('casual mentions - should NOT trigger', () => {
    it('should NOT detect "I was talking to Addie"', () => {
      const result = detectAddieInvocation('I was talking to Addie yesterday about membership.');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect "Addie mentioned..."', () => {
      const result = detectAddieInvocation('Addie mentioned that the pricing is $10K');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect "Addie said..."', () => {
      const result = detectAddieInvocation('Addie said the deadline is Friday');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect "I told Addie..."', () => {
      const result = detectAddieInvocation('I told Addie about the meeting');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect "Addie is..."', () => {
      const result = detectAddieInvocation('Addie is the AI assistant for AgenticAdvertising.org');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect "thanks Addie"', () => {
      const result = detectAddieInvocation('Thanks Addie for your help!');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect empty text', () => {
      const result = detectAddieInvocation('');
      expect(result.invoked).toBe(false);
    });

    it('should NOT detect plain message without Addie', () => {
      const result = detectAddieInvocation('Thanks for the information!');
      expect(result.invoked).toBe(false);
    });
  });

  describe('quoted content handling - the main bug fix', () => {
    it('should NOT trigger on invocations in quoted replies (> prefix)', () => {
      const email = `Thanks for the clarification, Brian. That's helpful.

> Addie, can you answer Adam's questions about membership?
>
> On Jan 3, 2025 at 9:00 AM, Adam wrote:
> > I have some questions about the $50K tier`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should NOT trigger on invocations after "On X wrote:" marker', () => {
      const email = `Got it, thanks!

On Jan 3, 2025 at 9:00 AM, Brian O'Kelley wrote:

Addie, can you help Adam with his questions?`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should NOT trigger on invocations in forwarded content', () => {
      const email = `FYI - see below

---------- Forwarded message ---------

Addie, please send the invoice to this prospect.`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should NOT trigger on invocations after signature divider', () => {
      const email = `Just checking in on this.

--
Brian O'Kelley
AgenticAdvertising.org

Addie, can you schedule a follow-up?`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should detect invocation in new message content before quotes', () => {
      const email = `Addie, can you send Adam the pricing document?

Thanks,
Brian

On Jan 3, 2025 at 9:00 AM, Adam wrote:

> I'm interested in learning more about membership.`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(true);
      expect(result.request).toContain('send Adam the pricing document');
    });

    it('should handle email with multiple quote levels', () => {
      const email = `Sounds good to me.

> > Addie, can you help with this?
> >
> > On Jan 2, Brian wrote:
> > > Original message
>
> Sure, I'll handle it.`;

      const result = detectAddieInvocation(email);
      // Should NOT trigger because "Addie, can you help" is in quoted content
      expect(result.invoked).toBe(false);
    });

    it('should NOT trigger on Apple Mail forwarded content', () => {
      const email = `Please see below.

Begin forwarded message:

From: Brian <brian@example.com>
Subject: Help needed
Date: January 3, 2025

Addie, can you assist with this request?`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should NOT trigger on Outlook-style original message', () => {
      const email = `Agreed.

-----Original Message-----
From: Brian
Sent: January 3, 2025

Addie, please handle this.`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(false);
    });

    it('should handle the actual bug scenario - client reply with quoted Addie invocation', () => {
      // This is the actual scenario from the bug report
      const email = `Thanks for the clarification, Brian. That's helpful.

Let me address these directly:

Participant list: You're actually the first person Brian has approached for this council.

$50K and membership tiers: The $50K is annual dues for council leadership.

On Jan 3, 2025 at 8:30 AM, Brian O'Kelley <bokelley@scope3.com> wrote:

Addie, can you answer Adam's questions about council membership? Here are the details:
- $50K tier
- Board seat eligibility
- 2027 renewal

Thanks!
Brian`;

      const result = detectAddieInvocation(email);
      // Should NOT trigger - the invocation is in a quoted section
      expect(result.invoked).toBe(false);
    });
  });

  describe('request extraction', () => {
    it('should extract request text after invocation pattern', () => {
      const result = detectAddieInvocation('Addie please send a payment link for the $10K membership');
      expect(result.invoked).toBe(true);
      // The pattern matches "Addie please", so request starts after that
      expect(result.request).toBe('send a payment link for the $10K membership');
    });

    it('should stop extraction at signature', () => {
      const email = `Addie send the invoice

--
Brian`;

      const result = detectAddieInvocation(email);
      expect(result.invoked).toBe(true);
      expect(result.request).toBe('the invoice');
    });

    it('should truncate very long requests', () => {
      const longRequest = 'a'.repeat(600);
      // Need to use a pattern that triggers - "Addie please" followed by long text
      const result = detectAddieInvocation(`Addie please ${longRequest}`);
      expect(result.invoked).toBe(true);
      expect(result.request?.length).toBeLessThanOrEqual(500);
    });
  });
});

describe('stripQuotedContent', () => {
  it('should strip lines starting with >', () => {
    const text = `New message here
> Quoted content
> More quoted content
Another new line`;

    const result = stripQuotedContent(text);
    expect(result).toBe('New message here\nAnother new line');
  });

  it('should stop at "On X wrote:" marker', () => {
    const text = `New message

On Jan 3, 2025 at 9:00 AM, Brian wrote:

Old message content`;

    const result = stripQuotedContent(text);
    expect(result).toBe('New message');
  });

  it('should stop at signature divider', () => {
    const text = `Message content

--
Signature here`;

    const result = stripQuotedContent(text);
    expect(result).toBe('Message content');
  });

  it('should stop at forwarded message marker', () => {
    const text = `FYI below

---------- Forwarded message ---------

Forwarded content`;

    const result = stripQuotedContent(text);
    expect(result).toBe('FYI below');
  });

  it('should handle empty input', () => {
    expect(stripQuotedContent('')).toBe('');
  });

  it('should handle text with no quotes', () => {
    const text = 'Just a plain message';
    expect(stripQuotedContent(text)).toBe('Just a plain message');
  });
});
