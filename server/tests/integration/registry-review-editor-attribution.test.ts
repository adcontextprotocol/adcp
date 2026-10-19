/**
 * The registry reviewer must diff an edit against the state the *editor*
 * started from — not an older one (adcp#8326).
 *
 * `editDiscoveredBrand` / `editCommunityProperty` snapshot the row **before**
 * applying the edit, so revision N is the pre-edit state and revision N is
 * what the reviewer needs. The MCP `save_brand` / `save_property` handlers
 * asked for revision N-1, which is the state before the *previous* member's
 * edit. Everything that member changed and this one left alone then showed
 * up in the review prompt as this member's submission — and a `malicious`
 * verdict bans whoever submitted the edit under review.
 *
 * These tests run the real revision machinery against Postgres and assert
 * the snapshot the handler hands the reviewer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://adcp:localdev@localhost:5432/adcp_test';
});

const mocks = vi.hoisted(() => ({
  reviewRegistryEdit: vi.fn().mockResolvedValue(undefined),
  reviewNewRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyRegistryCreate: vi.fn().mockResolvedValue(null),
  notifyRegistryEdit: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: mocks.reviewNewRecord,
  reviewRegistryEdit: mocks.reviewRegistryEdit,
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { MCPToolHandler } from '../../src/mcp-tools.js';
import type { MCPAuthContext } from '../../src/mcp/auth.js';

const DOMAIN = 'review-attribution.registry-baseline.com';
/** Text the first editor leaves in a field the second editor never touches. */
const PLANTED_BY_FIRST_EDITOR = 'planted-by-first-editor.example';

function auth(sub: string, email: string): MCPAuthContext {
  return { sub, isM2M: false, email, payload: {} };
}

/**
 * The MCP handler fires the review after the notification promise settles,
 * so let the microtask queue drain before asserting.
 */
async function settleFireAndForget(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('registry review diffs against the editor\'s own starting point', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;
  let handler: MCPToolHandler;

  async function clearFixtures() {
    await pool.query('DELETE FROM brand_revisions WHERE brand_domain = $1', [DOMAIN]);
    await pool.query('DELETE FROM brands WHERE domain = $1', [DOMAIN]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
    handler = new MCPToolHandler();
  }, 60000);

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  }, 30000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearFixtures();
  });

  it('hands the second editor\'s review the state the first editor left, not an older one', async () => {
    await brandDb.createDiscoveredBrand(
      { domain: DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_creator', email: 'creator@example.com' },
    );
    await brandDb.approveBrand(DOMAIN);

    // First editor sets a field the second editor will not resend.
    await handler.handleToolCall(
      'save_brand',
      { domain: DOMAIN, brand_name: 'Acme Corp', parent_brand: PLANTED_BY_FIRST_EDITOR, edit_summary: 'add parent' },
      auth('user_first', 'first@example.com'),
    );
    await settleFireAndForget();
    await brandDb.approveBrand(DOMAIN);
    mocks.reviewRegistryEdit.mockClear();

    // Second editor changes only the name. `parent_brand` keeps the first
    // editor's value because `save_brand` only updates what it is sent.
    await handler.handleToolCall(
      'save_brand',
      { domain: DOMAIN, brand_name: 'Acme Corporation', edit_summary: 'fix the name' },
      auth('user_second', 'second@example.com'),
    );
    await settleFireAndForget();

    expect(mocks.reviewRegistryEdit).toHaveBeenCalledTimes(1);
    const reviewed = mocks.reviewRegistryEdit.mock.calls[0][0] as {
      editor_user_id: string;
      old_snapshot: Record<string, unknown>;
      new_snapshot: Record<string, unknown>;
      revision_number: number;
    };

    expect(reviewed.editor_user_id).toBe('user_second');
    // The thing that matters: the first editor's field is already in the
    // "before" picture, so it is not attributed to the second editor.
    expect(reviewed.old_snapshot.parent_brand).toBe(PLANTED_BY_FIRST_EDITOR);
    expect(reviewed.new_snapshot.parent_brand).toBe(PLANTED_BY_FIRST_EDITOR);
    expect(reviewed.old_snapshot.brand_name).toBe('Acme Corp');
    expect(reviewed.new_snapshot.brand_name).toBe('Acme Corporation');
  }, 30000);

  it('reverting the edit under review restores the state it replaced', async () => {
    await brandDb.createDiscoveredBrand(
      { domain: DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_creator', email: 'creator@example.com' },
    );
    await brandDb.approveBrand(DOMAIN);

    await handler.handleToolCall(
      'save_brand',
      { domain: DOMAIN, brand_name: 'VANDALIZED', edit_summary: 'vandalism' },
      auth('user_vandal', 'vandal@example.com'),
    );
    await settleFireAndForget();
    await brandDb.approveBrand(DOMAIN);

    const reviewed = mocks.reviewRegistryEdit.mock.calls[0][0] as { revision_number: number };
    // `reviewRegistryEdit` rolls back to exactly this number.
    await brandDb.rollbackBrand(DOMAIN, reviewed.revision_number, {
      user_id: 'system:addie',
      email: 'addie@agenticadvertising.org',
    });

    const restored = await brandDb.getDiscoveredBrandByDomain(DOMAIN);
    expect(restored?.brand_name).toBe('Acme Corp');
  }, 30000);
});
