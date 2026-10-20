/**
 * The registry reviewer allowlists the snapshot it is handed, so every
 * caller must hand it a registry **row**. A caller that passes a bare
 * `adagents.json` document instead shares none of the allowlisted field
 * names, and the reviewer ends up judging `{}` — with no error anywhere.
 *
 * `enhanceProperty` is the caller that does not go through a revision write,
 * so nothing else covers it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reviewNewRecord: vi.fn().mockResolvedValue(undefined),
  createHostedProperty: vi.fn(),
  getHostedPropertyByDomain: vi.fn().mockResolvedValue(null),
  validateDomain: vi.fn().mockResolvedValue({ valid: false }),
  anthropicCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  return { default: FakeAnthropic, APIError };
});

vi.mock('../../src/adagents-manager.js', () => ({
  AdAgentsManager: class {
    validateDomain = mocks.validateDomain;
  },
}));

vi.mock('../../src/db/property-db.js', () => ({
  PropertyDatabase: class {
    getHostedPropertyByDomain = mocks.getHostedPropertyByDomain;
    createHostedProperty = mocks.createHostedProperty;
  },
}));

vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: mocks.reviewNewRecord,
}));

import { sanitizePropertySnapshot } from '../../src/db/registry-revision-snapshot.js';

describe('enhanceProperty hands the reviewer a registry row', () => {
  let enhanceProperty: typeof import('../../src/services/property-enhancement.js').enhanceProperty;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.clearAllMocks();
    mocks.getHostedPropertyByDomain.mockResolvedValue(null);
    mocks.validateDomain.mockResolvedValue({ valid: false });
    mocks.anthropicCreate.mockResolvedValue({ content: [] });
    mocks.createHostedProperty.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'prop_01',
      ...input,
      domain_verified: false,
      verification_token: 'verify_tok_live',
      claim_token: 'claim_tok_live',
      created_at: new Date(),
      updated_at: new Date(),
    }));
    vi.resetModules();
    ({ enhanceProperty } = await import('../../src/services/property-enhancement.js'));
  });

  it('survives the reviewer\'s allowlist with the submission content intact', async () => {
    await enhanceProperty('news.example', 'user_01SUBMITTER', 'submitter@example.com');

    expect(mocks.reviewNewRecord).toHaveBeenCalledOnce();
    const { snapshot } = mocks.reviewNewRecord.mock.calls[0][0];

    // What the reviewer will actually read, after its own sanitization.
    const reviewed = sanitizePropertySnapshot(snapshot) as Record<string, any>;
    expect(reviewed.publisher_domain).toBe('news.example');
    expect(reviewed.adagents_json?.ext?.enhancement).toMatchObject({
      enhanced_by: 'user_01SUBMITTER',
      has_adagents: false,
    });

    // And not at the cost of re-introducing the fields the allowlist exists for.
    expect(reviewed).not.toHaveProperty('claim_token');
    expect(reviewed).not.toHaveProperty('verification_token');
    expect(reviewed).not.toHaveProperty('created_by_email');
  });
});
