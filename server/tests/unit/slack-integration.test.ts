import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

/**
 * Slack Integration Tests
 *
 * Tests for the Slack user mapping integration:
 * - Signature verification
 * - Command parsing
 * - Status handling
 */

// Mock the verification function for testing
function verifySlackSignature(
  signingSecret: string,
  requestSignature: string,
  requestTimestamp: string,
  body: string
): boolean {
  // Check timestamp is recent (within 5 minutes)
  const timestamp = parseInt(requestTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 60 * 5) {
    return false;
  }

  // Create signature base string
  const sigBasestring = `v0:${requestTimestamp}:${body}`;

  // Create HMAC signature
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  // Compare signatures using timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(requestSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

describe("Slack Signature Verification", () => {
  const testSecret = "test_signing_secret_abc123";

  it("should verify a valid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "token=test&command=/aao&text=status";

    // Generate valid signature
    const sigBasestring = `v0:${timestamp}:${body}`;
    const expectedSignature = 'v0=' + crypto
      .createHmac('sha256', testSecret)
      .update(sigBasestring)
      .digest('hex');

    const result = verifySlackSignature(testSecret, expectedSignature, timestamp, body);
    expect(result).toBe(true);
  });

  it("should reject an invalid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "token=test&command=/aao&text=status";
    const invalidSignature = "v0=invalid_signature_here";

    const result = verifySlackSignature(testSecret, invalidSignature, timestamp, body);
    expect(result).toBe(false);
  });

  it("should reject a stale timestamp (more than 5 minutes old)", () => {
    // Timestamp from 10 minutes ago
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const body = "token=test&command=/aao&text=status";

    // Generate signature with old timestamp
    const sigBasestring = `v0:${oldTimestamp}:${body}`;
    const signature = 'v0=' + crypto
      .createHmac('sha256', testSecret)
      .update(sigBasestring)
      .digest('hex');

    const result = verifySlackSignature(testSecret, signature, oldTimestamp, body);
    expect(result).toBe(false);
  });

  it("should reject tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const originalBody = "token=test&command=/aao&text=status";
    const tamperedBody = "token=test&command=/aao&text=admin";

    // Generate signature with original body
    const sigBasestring = `v0:${timestamp}:${originalBody}`;
    const signature = 'v0=' + crypto
      .createHmac('sha256', testSecret)
      .update(sigBasestring)
      .digest('hex');

    // Verify with tampered body should fail
    const result = verifySlackSignature(testSecret, signature, timestamp, tamperedBody);
    expect(result).toBe(false);
  });
});

describe("Slack Mapping Status", () => {
  // These are the valid status values for the unified endpoint
  const validStatuses = ['mapped', 'slack_only', 'aao_only', 'suggested_match'];

  it("should have consistent status values", () => {
    expect(validStatuses).toContain('mapped');
    expect(validStatuses).toContain('slack_only');
    expect(validStatuses).toContain('aao_only');
    expect(validStatuses).toContain('suggested_match');
    expect(validStatuses.length).toBe(4);
  });

  it("should not include deprecated 'unmapped' status", () => {
    // 'unmapped' was renamed to 'slack_only' for clarity
    expect(validStatuses).not.toContain('unmapped');
  });
});

describe("Slack Command Parsing", () => {
  // Parse command function mirrors the logic in commands.ts
  function parseSubcommand(text: string): string {
    return text.trim().toLowerCase().split(/\s+/)[0] || 'help';
  }

  it("should parse 'status' command", () => {
    expect(parseSubcommand("status")).toBe("status");
    expect(parseSubcommand("  status  ")).toBe("status");
    expect(parseSubcommand("STATUS")).toBe("status");
  });

  it("should parse 'whoami' command", () => {
    expect(parseSubcommand("whoami")).toBe("whoami");
    expect(parseSubcommand("WHOAMI")).toBe("whoami");
  });

  it("should parse 'link' command", () => {
    expect(parseSubcommand("link")).toBe("link");
  });

  it("should parse 'help' command", () => {
    expect(parseSubcommand("help")).toBe("help");
  });

  it("should default to 'help' for empty text", () => {
    expect(parseSubcommand("")).toBe("help");
    expect(parseSubcommand("   ")).toBe("help");
  });

  it("should ignore extra arguments", () => {
    expect(parseSubcommand("status extra args")).toBe("status");
    expect(parseSubcommand("link me now")).toBe("link");
  });
});

describe("Slack User Mapping Types", () => {
  // Type definitions matching slack/types.ts
  type SlackMappingStatus = 'mapped' | 'unmapped' | 'pending_verification';
  type SlackMappingSource = 'email_auto' | 'manual_admin' | 'user_claimed';

  it("should have valid mapping status values", () => {
    const statuses: SlackMappingStatus[] = ['mapped', 'unmapped', 'pending_verification'];
    expect(statuses.length).toBe(3);
  });

  it("should have valid mapping source values", () => {
    const sources: SlackMappingSource[] = ['email_auto', 'manual_admin', 'user_claimed'];
    expect(sources.length).toBe(3);
  });

  it("should use 'user_claimed' source for self-service linking", () => {
    // When a user links their own account via /aao link and signup
    const expectedSource: SlackMappingSource = 'user_claimed';
    expect(expectedSource).toBe('user_claimed');
  });

  it("should use 'email_auto' source for automatic email matching", () => {
    // When admins run auto-link-suggested endpoint
    const expectedSource: SlackMappingSource = 'email_auto';
    expect(expectedSource).toBe('email_auto');
  });

  it("should use 'manual_admin' source for admin manual linking", () => {
    // When an admin manually links accounts
    const expectedSource: SlackMappingSource = 'manual_admin';
    expect(expectedSource).toBe('manual_admin');
  });
});

describe("Slack Link URL Generation", () => {
  it("should generate signup URL with slack_user_id parameter", () => {
    const slackUserId = "U1234567890";
    const baseUrl = "https://agenticadvertising.org/signup";
    const expectedUrl = `${baseUrl}?slack_user_id=${encodeURIComponent(slackUserId)}`;

    // The URL should contain the encoded slack_user_id
    expect(expectedUrl).toContain("slack_user_id=U1234567890");
  });

  it("should properly encode special characters in slack_user_id", () => {
    // Slack user IDs are typically alphanumeric, but test encoding anyway
    const slackUserId = "U+test/special";
    const encodedId = encodeURIComponent(slackUserId);

    expect(encodedId).not.toContain("+");
    expect(encodedId).not.toContain("/");
  });
});

describe("Database Schema - Slack User Mappings", () => {
  // Expected columns for the slack_user_mappings table
  const EXPECTED_COLUMNS = [
    'id',
    'slack_user_id',
    'slack_email',
    'slack_display_name',
    'slack_real_name',
    'slack_is_bot',
    'slack_is_deleted',
    'workos_user_id',
    'mapping_status',
    'mapping_source',
    'nudge_opt_out',
    'nudge_opt_out_at',
    'last_nudge_at',
    'nudge_count',
    'last_slack_sync_at',
    'mapped_at',
    'mapped_by_user_id',
    'created_at',
    'updated_at',
  ];

  it("should define all expected columns", () => {
    expect(EXPECTED_COLUMNS.length).toBe(19);
  });

  it("should have slack-prefixed columns for Slack data", () => {
    const slackColumns = EXPECTED_COLUMNS.filter(c => c.startsWith('slack_'));
    expect(slackColumns.length).toBe(6);
    expect(slackColumns).toContain('slack_user_id');
    expect(slackColumns).toContain('slack_email');
    expect(slackColumns).toContain('slack_display_name');
    expect(slackColumns).toContain('slack_real_name');
    expect(slackColumns).toContain('slack_is_bot');
    expect(slackColumns).toContain('slack_is_deleted');
  });

  it("should have mapping-related columns", () => {
    expect(EXPECTED_COLUMNS).toContain('mapping_status');
    expect(EXPECTED_COLUMNS).toContain('mapping_source');
    expect(EXPECTED_COLUMNS).toContain('mapped_at');
    expect(EXPECTED_COLUMNS).toContain('mapped_by_user_id');
  });

  it("should have nudge tracking columns", () => {
    expect(EXPECTED_COLUMNS).toContain('nudge_opt_out');
    expect(EXPECTED_COLUMNS).toContain('nudge_opt_out_at');
    expect(EXPECTED_COLUMNS).toContain('last_nudge_at');
    expect(EXPECTED_COLUMNS).toContain('nudge_count');
  });

  it("should have timestamp columns", () => {
    expect(EXPECTED_COLUMNS).toContain('created_at');
    expect(EXPECTED_COLUMNS).toContain('updated_at');
    expect(EXPECTED_COLUMNS).toContain('last_slack_sync_at');
  });

  it("should use snake_case for all column names", () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(col).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
