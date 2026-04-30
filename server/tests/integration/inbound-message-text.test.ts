/**
 * Integration test for #3580: inbound message text persistence.
 *
 * Verifies that a `message_received` row written through the canonical path
 * (recordEvent + capEventText) round-trips through getPersonTimeline with the
 * text intact, and that older rows without `text` continue to read cleanly
 * (backward compatibility).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { capEventText, recordEvent, getPersonTimeline } from '../../src/db/person-events-db.js';
import { resolvePersonId } from '../../src/db/relationship-db.js';

const TEST_DOMAIN = 'inbound-text-test.example.com';

async function cleanup() {
  await query(
    `DELETE FROM person_events
     WHERE person_id IN (SELECT id FROM person_relationships WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  );
  await query('DELETE FROM person_relationships WHERE email LIKE $1', [`%@${TEST_DOMAIN}`]);
}

describe('inbound message_received text persistence', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    await cleanup();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(cleanup);

  it('stores inbound text on message_received and reads it back via getPersonTimeline', async () => {
    const personId = await resolvePersonId({ email: `tej@${TEST_DOMAIN}` });

    const original = 'Hi Addie — my colleagues can\'t log in. Can you help?';
    const capped = capEventText(original);

    await recordEvent(personId, 'message_received', {
      channel: 'slack',
      data: {
        source: 'dm',
        text: capped.text,
        text_length: capped.original_length,
      },
    });

    const events = await getPersonTimeline(personId, {
      eventTypes: ['message_received'],
    });

    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      source: 'dm',
      text: original,
      text_length: original.length,
    });
    expect(events[0].data.truncated).toBeUndefined();
  });

  it('flags truncated when text exceeds the byte cap', async () => {
    const personId = await resolvePersonId({ email: `big@${TEST_DOMAIN}` });

    const huge = 'x'.repeat(70 * 1024);
    const capped = capEventText(huge);

    await recordEvent(personId, 'message_received', {
      channel: 'web',
      data: {
        source: 'web_chat',
        text: capped.text,
        text_length: capped.original_length,
        ...(capped.truncated ? { truncated: true } : {}),
      },
    });

    const events = await getPersonTimeline(personId, {
      eventTypes: ['message_received'],
    });

    expect(events).toHaveLength(1);
    expect(events[0].data.truncated).toBe(true);
    expect((events[0].data.text as string).length).toBeLessThanOrEqual(64 * 1024);
    expect(events[0].data.text_length).toBe(70 * 1024);
  });

  it('reads pre-existing rows that have text_length but no text (backward compat)', async () => {
    const personId = await resolvePersonId({ email: `legacy@${TEST_DOMAIN}` });

    // Simulate an old row written before this PR — text_length only
    await recordEvent(personId, 'message_received', {
      channel: 'slack',
      data: { source: 'dm', text_length: 42 },
    });

    const events = await getPersonTimeline(personId, {
      eventTypes: ['message_received'],
    });
    expect(events).toHaveLength(1);
    expect(events[0].data.text_length).toBe(42);
    expect(events[0].data.text).toBeUndefined();
  });
});
