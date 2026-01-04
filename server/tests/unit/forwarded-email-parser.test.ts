import { describe, it, expect } from 'vitest';
import {
  parseForwardedEmailHeaders,
  formatEmailAddress,
  mergeAddresses,
} from '../../src/utils/forwarded-email-parser.js';

describe('forwarded-email-parser', () => {
  describe('parseForwardedEmailHeaders', () => {
    describe('forward detection', () => {
      it('should detect Gmail forwarded message marker', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
Date: Mon, Dec 25, 2024 at 10:00 AM
Subject: Meeting Notes
To: Jane Smith <jane@company.com>

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('Some subject', body);
        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('high');
      });

      it('should detect Apple Mail "Begin forwarded message:"', () => {
        const body = `
Begin forwarded message:

From: John Doe <john@example.com>
Subject: Meeting Notes
Date: December 25, 2024 at 10:00:00 AM EST
To: Jane Smith <jane@company.com>

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('Some subject', body);
        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('high');
      });

      it('should detect Outlook "Original Message" marker', () => {
        const body = `
Please see below.

-----Original Message-----
From: John Doe <john@example.com>
Sent: Monday, December 25, 2024 10:00 AM
To: Jane Smith <jane@company.com>
Subject: Meeting Notes

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('Some subject', body);
        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('high');
      });

      it('should detect FW: in subject line', () => {
        const body = `
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Subject: Original Subject

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('FW: Original Subject', body);
        expect(result.isForwarded).toBe(true);
      });

      it('should detect Fwd: in subject line', () => {
        const body = `
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('Fwd: Original Subject', body);
        expect(result.isForwarded).toBe(true);
      });

      it('should return isForwarded=false for regular emails', () => {
        const body = `
Hey John,

Just following up on our conversation.

Best,
Jane
`;
        const result = parseForwardedEmailHeaders('Follow up', body);
        expect(result.isForwarded).toBe(false);
        expect(result.originalTo).toEqual([]);
        expect(result.originalCc).toEqual([]);
      });

      it('should return isForwarded=false for empty body', () => {
        const result = parseForwardedEmailHeaders('Some subject', undefined);
        expect(result.isForwarded).toBe(false);
      });
    });

    describe('header extraction', () => {
      it('should extract From header', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
Date: Mon, Dec 25, 2024 at 10:00 AM
Subject: Meeting Notes
To: Jane Smith <jane@company.com>

Hey, here are the notes...
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalFrom).toEqual({
          email: 'john@example.com',
          displayName: 'John Doe',
        });
      });

      it('should extract To header with single recipient', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Subject: Meeting

Content here
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo).toHaveLength(1);
        expect(result.originalTo[0]).toEqual({
          email: 'jane@company.com',
          displayName: 'Jane Smith',
        });
      });

      it('should extract To header with multiple recipients', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>, Bob Wilson <bob@other.com>
Subject: Meeting

Content here
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo).toHaveLength(2);
        expect(result.originalTo[0].email).toBe('jane@company.com');
        expect(result.originalTo[1].email).toBe('bob@other.com');
      });

      it('should extract Cc header', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Cc: Alice Manager <alice@company.com>, Bob Director <bob@company.com>
Subject: Meeting

Content here
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalCc).toHaveLength(2);
        expect(result.originalCc[0].email).toBe('alice@company.com');
        expect(result.originalCc[1].email).toBe('bob@company.com');
      });

      it('should handle missing Cc header', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Subject: Meeting

Content here
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalCc).toEqual([]);
      });

      it('should extract Subject', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Subject: Important Meeting Notes
Date: Dec 25, 2024

Content here
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalSubject).toBe('Important Meeting Notes');
      });
    });

    describe('address parsing', () => {
      it('should parse "Name <email>" format', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo[0]).toEqual({
          email: 'jane@company.com',
          displayName: 'Jane Smith',
        });
      });

      it('should parse plain email format', () => {
        const body = `
---------- Forwarded message ---------
From: john@example.com
To: jane@company.com

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo[0]).toEqual({
          email: 'jane@company.com',
          displayName: null,
        });
      });

      it('should parse quoted "Name, Title" <email> format', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: "Smith, Jane" <jane@company.com>

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo[0].email).toBe('jane@company.com');
        expect(result.originalTo[0].displayName).toBe('Smith, Jane');
      });

      it('should handle comma-separated multiple addresses with quoted names', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: "Brown, Jason A" <jason.brown@charter.com>, "Smith, Jane B" <jane@company.com>
Cc: Bob Wilson <bob@other.com>

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo).toHaveLength(2);
        expect(result.originalTo[0].email).toBe('jason.brown@charter.com');
        expect(result.originalTo[0].displayName).toBe('Brown, Jason A');
        expect(result.originalTo[1].email).toBe('jane@company.com');
        expect(result.originalTo[1].displayName).toBe('Smith, Jane B');
      });

      it('should lowercase email addresses', () => {
        const body = `
---------- Forwarded message ---------
From: John@EXAMPLE.COM
To: JANE@Company.Com

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo[0].email).toBe('jane@company.com');
      });

      it('should preserve display name casing', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane SMITH <jane@company.com>

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo[0].displayName).toBe('Jane SMITH');
      });
    });

    describe('edge cases', () => {
      it('should only parse first forward block (nested forwards)', () => {
        const body = `
---------- Forwarded message ---------
From: Middle Person <middle@example.com>
To: Final Recipient <final@company.com>
Subject: Fwd: Original

---------- Forwarded message ---------
From: Original Sender <original@other.com>
To: Middle Person <middle@example.com>
Subject: Original

Original content
`;
        const result = parseForwardedEmailHeaders('Fwd: Fwd: Original', body);
        // Should get the first (outermost) forward's recipients
        expect(result.originalTo[0].email).toBe('final@company.com');
      });

      it('should handle partial headers (missing some fields)', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>

Content without subject or date
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.isForwarded).toBe(true);
        expect(result.originalTo).toHaveLength(1);
        expect(result.originalSubject).toBeUndefined();
      });

      it('should return empty arrays for unparseable content', () => {
        const body = `
---------- Forwarded message ---------
This email has no proper headers
Just some random content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.isForwarded).toBe(true);
        expect(result.originalTo).toEqual([]);
        expect(result.originalCc).toEqual([]);
        expect(result.confidence).toBe('low');
      });

      it('should handle multi-line address lists', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>,
    Bob Wilson <bob@other.com>,
    Alice Manager <alice@third.com>
Subject: Meeting

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.originalTo).toHaveLength(3);
        expect(result.originalTo[0].email).toBe('jane@company.com');
        expect(result.originalTo[1].email).toBe('bob@other.com');
        expect(result.originalTo[2].email).toBe('alice@third.com');
      });
    });

    describe('confidence levels', () => {
      it('should return high confidence for marker + complete headers', () => {
        const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>
Subject: Meeting

Content
`;
        const result = parseForwardedEmailHeaders('Fwd: test', body);
        expect(result.confidence).toBe('high');
      });

      it('should return medium confidence for subject-only detection with headers', () => {
        const body = `
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>

Content without forward marker
`;
        const result = parseForwardedEmailHeaders('FW: Meeting Notes', body);
        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('medium');
      });

      it('should return low confidence for subject-only without parseable headers', () => {
        const body = `Just some content without any headers`;
        const result = parseForwardedEmailHeaders('FW: Something', body);
        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('low');
      });
    });

    describe('real-world example', () => {
      it('should parse Charter/Spectrum style forwarded email', () => {
        const body = `
For the records & prospecting - charter/spectrum is interested

---------- Forwarded message ---------
From: Brian O'Kelley <bokelley@scope3.com>
Date: Saturday, December 20, 2025 at 9:47 AM
To: John Lee <john@scoutdataadvisors.com>
Cc: Brown, Jason A <Jason.A.Brown@charter.com>, Klippel, Rob <Rob.Klippel@charter.com>, Harvin
    Gupta <hgupta@scope3.com>, Amber Uhle <amber.n.uhle@gmail.com>, Morgan Ramirez Zapata
    <mramirez@scope3.com>, Dennis, Rhonda D <Rhonda.Dennis@charter.com>, Vellucci, Lynne
    <Lynne.Vellucci@charter.com>
Subject: Re: 9:00 am (est) Meeting w/Scope3/adcp/charter (45 minutes)

John - sounds great! Morgan is on the thread to set up that deeper dive.

On the AdCP/AAO membership that would be great - we'll kick off the TV working group in January, and
would love to have Charter as a core member.

Have a great holiday!
`;
        const result = parseForwardedEmailHeaders('FW: 9:00 am (est) Meeting w/Scope3/adcp/charter (45 minutes)', body);

        expect(result.isForwarded).toBe(true);
        expect(result.confidence).toBe('high');

        // Check FROM
        expect(result.originalFrom?.email).toBe('bokelley@scope3.com');
        expect(result.originalFrom?.displayName).toBe("Brian O'Kelley");

        // Check TO
        expect(result.originalTo).toHaveLength(1);
        expect(result.originalTo[0].email).toBe('john@scoutdataadvisors.com');
        expect(result.originalTo[0].displayName).toBe('John Lee');

        // Check CC - should have multiple Charter contacts
        expect(result.originalCc.length).toBeGreaterThan(0);
        const charterEmails = result.originalCc.filter(c => c.email.includes('charter.com'));
        expect(charterEmails.length).toBeGreaterThanOrEqual(1);

        // Check subject
        expect(result.originalSubject).toContain('Meeting w/Scope3/adcp/charter');
      });
    });
  });

  describe('formatEmailAddress', () => {
    it('should format address with display name', () => {
      const result = formatEmailAddress({
        email: 'john@example.com',
        displayName: 'John Doe',
      });
      expect(result).toBe('John Doe <john@example.com>');
    });

    it('should format address without display name', () => {
      const result = formatEmailAddress({
        email: 'john@example.com',
        displayName: null,
      });
      expect(result).toBe('john@example.com');
    });

    it('should quote display names with commas', () => {
      const result = formatEmailAddress({
        email: 'john@example.com',
        displayName: 'Doe, John',
      });
      expect(result).toBe('"Doe, John" <john@example.com>');
    });
  });

  describe('mergeAddresses', () => {
    it('should merge two arrays without duplicates', () => {
      const existing = ['john@example.com', 'jane@company.com'];
      const additional = ['bob@other.com', 'john@example.com'];

      const result = mergeAddresses(existing, additional);

      expect(result).toHaveLength(3);
      expect(result).toContain('john@example.com');
      expect(result).toContain('jane@company.com');
      expect(result).toContain('bob@other.com');
    });

    it('should preserve existing entries over additional', () => {
      const existing = ['John Doe <john@example.com>'];
      const additional = ['john@example.com']; // Same email, different format

      const result = mergeAddresses(existing, additional);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('John Doe <john@example.com>');
    });

    it('should be case-insensitive for deduplication', () => {
      const existing = ['JOHN@example.com'];
      const additional = ['john@EXAMPLE.COM'];

      const result = mergeAddresses(existing, additional);

      expect(result).toHaveLength(1);
    });

    it('should handle empty arrays', () => {
      expect(mergeAddresses([], [])).toEqual([]);
      expect(mergeAddresses(['a@b.com'], [])).toEqual(['a@b.com']);
      expect(mergeAddresses([], ['a@b.com'])).toEqual(['a@b.com']);
    });
  });

  describe('security and edge cases', () => {
    it('should detect forward marker in body even with empty subject', () => {
      const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: Jane Smith <jane@company.com>

Content
`;
      const result = parseForwardedEmailHeaders('', body);
      expect(result.isForwarded).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('should handle display names with special characters safely', () => {
      const result = formatEmailAddress({
        email: 'test@example.com',
        displayName: '<script>alert("xss")</script>',
      });
      // Should quote the display name, not execute as HTML
      expect(result).toBe('"<script>alert("xss")</script>" <test@example.com>');
    });

    it('should handle large number of recipients efficiently', () => {
      const recipients = Array.from({ length: 50 }, (_, i) =>
        `User ${i} <user${i}@example.com>`
      ).join(', ');

      const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: ${recipients}

Content
`;
      const start = Date.now();
      const result = parseForwardedEmailHeaders('Fwd: test', body);
      const elapsed = Date.now() - start;

      expect(result.originalTo.length).toBe(50);
      expect(elapsed).toBeLessThan(100); // Should complete quickly
    });

    it('should return empty result for excessively large body', () => {
      // Create a body larger than MAX_BODY_SIZE (1MB)
      const largeBody = 'x'.repeat(1_000_001);
      const result = parseForwardedEmailHeaders('Fwd: test', largeBody);
      expect(result.isForwarded).toBe(false);
    });

    it('should handle unbalanced quotes gracefully', () => {
      const body = `
---------- Forwarded message ---------
From: John Doe <john@example.com>
To: "Unbalanced Name <jane@company.com>, Bob <bob@other.com>

Content
`;
      // Should not hang or throw, and should extract what it can
      const result = parseForwardedEmailHeaders('Fwd: test', body);
      expect(result.isForwarded).toBe(true);
    });
  });
});
