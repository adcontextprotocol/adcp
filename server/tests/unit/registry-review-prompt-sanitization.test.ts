/**
 * The registry reviewer quotes record content into an LLM prompt and into
 * the moderator queue. Registry rows reach it straight from the write paths,
 * so it applies the snapshot allowlists itself — a row's credentials and
 * contact columns are not content a reviewer needs, and an LLM prompt is not
 * a place to put them.
 *
 * Sibling file `registry-review-prompt-boundary.test.ts` stubs
 * `sanitizeBrandSnapshot` to identity to keep its subject the fence; this one
 * runs the real sanitizers, so neither half is left unexercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  approveBrand: vi.fn(async () => undefined),
  approveProperty: vi.fn(async () => undefined),
  recordRegistryReviewOutcome: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  return { default: FakeAnthropic };
});

// The real sanitizers stay in place; only the database and the network go.
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getClient: vi.fn(),
  getPool: () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  isDatabaseInitialized: () => false,
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyAddieReview: mocks.notify,
  notifyRegistryApproval: mocks.notify,
  notifyRegistryBan: mocks.notify,
}));

vi.mock('../../src/db/registry-review-queue-db.js', () => ({
  recordRegistryReviewOutcome: mocks.recordRegistryReviewOutcome,
}));

const SECRETS = [
  'claim_tok_live',
  'verify_tok_live',
  'org_01OWNER',
  'org_01CLAIMANT',
  'org_01PRIOR',
  'creator@example.com',
];

/** A `hosted_properties` row as the write paths hand it over. */
const PROPERTY_ROW = {
  id: 'prop_01',
  publisher_domain: 'news.example',
  adagents_json: { authorized_agents: [{ url: 'https://agent.example' }] },
  source_type: 'community',
  review_status: 'pending',
  claim_token: 'claim_tok_live',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  claimant_org_id: 'org_01CLAIMANT',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'creator@example.com',
};

/** A `brands` row as the write paths hand it over. */
const BRAND_ROW = {
  id: 'brand_01',
  domain: 'acme.example',
  brand_name: 'Acme Corp',
  brand_manifest: { name: 'Acme Corp' },
  source_type: 'community',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  prior_owner_org_id: 'org_01PRIOR',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'creator@example.com',
};

function verdictResponse(verdict: string, reason = 'because') {
  return { content: [{ type: 'text', text: JSON.stringify({ verdict, reason }) }] };
}

function lastPrompt(): string {
  const call = mocks.anthropicCreate.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call![0] as { messages: Array<{ content: string }> }).messages[0].content;
}

let registryReview: typeof import('../../src/addie/mcp/registry-review.js');

beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  vi.clearAllMocks();
  vi.resetModules();
  registryReview = await import('../../src/addie/mcp/registry-review.js');
});

describe('a document passed where a registry row belongs', () => {
  it('fails loudly instead of letting the reviewer judge an empty object', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));

    await expect(registryReview.reviewNewRecord({
      entity_type: 'property',
      domain: 'news.example',
      editor_user_id: 'user_01SUBMITTER',
      // A bare adagents.json document: no key here is a registry column.
      snapshot: { $schema: 'https://adcontextprotocol.org/schemas/latest/adagents.json', authorized_agents: [] },
    })).rejects.toThrow(/not a registry row/);

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('leaves an already-empty snapshot alone', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));
    await expect(registryReview.reviewRegistryEdit({
      entity_type: 'property',
      domain: 'news.example',
      editor_user_id: 'user_01SUBMITTER',
      edit_summary: 'First edit on a record with no prior revision',
      old_snapshot: {},
      new_snapshot: { ...PROPERTY_ROW },
      revision_number: 1,
    })).resolves.toBeDefined();
  });
});

describe.each([
  { label: 'property', row: PROPERTY_ROW, content: 'https://agent.example' },
  { label: 'brand', row: BRAND_ROW, content: 'Acme Corp' },
] as const)('$label review prompts', ({ label, row, content }) => {
  it('quotes the record content without the row credentials or contact fields', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));

    await registryReview.reviewNewRecord({
      entity_type: label,
      domain: 'news.example',
      editor_user_id: 'user_01SUBMITTER',
      editor_email: 'submitter@example.com',
      snapshot: { ...row },
    });

    const prompt = lastPrompt();
    expect(prompt).toContain(content);
    for (const secret of SECRETS) expect(prompt).not.toContain(secret);
  });

  it('diffs an edit without the row credentials or contact fields', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));

    await registryReview.reviewRegistryEdit({
      entity_type: label,
      domain: 'news.example',
      editor_user_id: 'user_01SUBMITTER',
      editor_email: 'submitter@example.com',
      edit_summary: 'Tidied the record',
      old_snapshot: { ...row, claim_token: 'claim_tok_old', verification_token: 'verify_tok_old' },
      // A credential that *changed* is the case that matters: the diff quotes
      // submitted values, so an unsanitized rotation would land in the prompt.
      new_snapshot: { ...row, source_type: 'enriched' },
      revision_number: 2,
    });

    const prompt = lastPrompt();
    expect(prompt).toContain('source_type');
    for (const secret of SECRETS) expect(prompt).not.toContain(secret);
  });
});
