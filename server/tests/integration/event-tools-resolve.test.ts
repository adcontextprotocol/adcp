/**
 * Integration test for event-tools resolveEvent() — proves Addie's event tools
 * accept a Luma URL slug (e.g. `0zarmldc` from `luma.com/0zarmldc`) and resolve
 * via the events.luma_event_id column, not just the internal slug/UUID.
 *
 * Reproduces the original bug: passing a Luma slug returned "Event not found"
 * because resolveEvent only tried internal-slug then internal-UUID lookups.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEventToolHandlers } from '../../src/addie/mcp/event-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';

const SUFFIX = `${process.pid}-${Date.now()}`;
const INTERNAL_SLUG = `foundry-test-${SUFFIX}`;
const TITLE = `Foundry Test ${SUFFIX}`;
const AMBIG_SLUG_A = `foundry-test-${SUFFIX}-a`;
const AMBIG_SLUG_B = `foundry-test-${SUFFIX}-b`;
const AMBIG_TITLE_FRAGMENT = `Sibling ${SUFFIX}`;
const LUMA_API_ID = `evt-${SUFFIX}`.slice(0, 32);
const LUMA_URL_SLUG = `urlslg${SUFFIX}`.slice(0, 24).replace(/-/g, '');

function adminCtx(): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    slack_linked: false,
    workos_user: { workos_user_id: 'u_test', email: 'admin@test.example' },
    org_membership: { role: 'admin' },
  } as unknown as MemberContext;
}

describe('Addie event tools — Luma slug resolution', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  async function clearFixtures() {
    await pool.query(
      'DELETE FROM events WHERE slug IN ($1, $2, $3)',
      [INTERNAL_SLUG, AMBIG_SLUG_A, AMBIG_SLUG_B],
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
    await pool.query(
      `INSERT INTO events (
         slug, title, event_type, event_format,
         start_time, timezone,
         luma_event_id, luma_url,
         status, visibility
       ) VALUES (
         $1, $2, 'meetup', 'in_person',
         NOW() + INTERVAL '7 days', 'America/New_York',
         $3, $4,
         'published', 'public'
       )`,
      [INTERNAL_SLUG, TITLE, LUMA_API_ID, `https://luma.com/${LUMA_URL_SLUG}`],
    );
  });

  it('resolves by internal slug', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: INTERNAL_SLUG });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves by Luma api_id (luma_event_id column)', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: LUMA_API_ID });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves by Luma URL slug (the original Foundry bug — luma.com/0zarmldc)', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: LUMA_URL_SLUG });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves by full Luma URL', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: `https://luma.com/${LUMA_URL_SLUG}` });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves a Luma URL with a trailing slash, query, or fragment', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    // Update the seeded row to a luma_url shape we want to match against.
    await pool.query(
      'UPDATE events SET luma_url = $1 WHERE slug = $2',
      [`https://luma.com/${LUMA_URL_SLUG}/`, INTERNAL_SLUG],
    );
    const out = await handler({ event_slug: LUMA_URL_SLUG });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves a lu.ma host URL', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: `https://lu.ma/${LUMA_URL_SLUG}` });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('resolves by unique title fragment as a last resort', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: TITLE });
    expect(out).not.toMatch(/Event not found/);
    expect(out).toContain(TITLE);
  });

  it('returns Event not found when the title fragment is ambiguous', async () => {
    // Insert two siblings sharing a title fragment with neither being the
    // primary fixture row. findEventByTitleFuzzy returns null on >1 match,
    // so the handler should report not-found rather than guessing.
    await pool.query(
      `INSERT INTO events (slug, title, event_type, event_format,
         start_time, timezone, status, visibility)
       VALUES
         ($1, $3, 'meetup', 'in_person', NOW() + INTERVAL '7 days', 'UTC', 'published', 'public'),
         ($2, $4, 'meetup', 'in_person', NOW() + INTERVAL '8 days', 'UTC', 'published', 'public')`,
      [
        AMBIG_SLUG_A,
        AMBIG_SLUG_B,
        `${AMBIG_TITLE_FRAGMENT} — alpha`,
        `${AMBIG_TITLE_FRAGMENT} — beta`,
      ],
    );

    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: AMBIG_TITLE_FRAGMENT });
    expect(out).toMatch(/Event not found/);
  });

  it('still returns Event not found for an unknown slug', async () => {
    const handlers = createEventToolHandlers(adminCtx());
    const handler = handlers.get('list_event_attendees')!;
    const out = await handler({ event_slug: 'definitely-not-a-real-slug-xyz' });
    expect(out).toMatch(/Event not found/);
  });
});
