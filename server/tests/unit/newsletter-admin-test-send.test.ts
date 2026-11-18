import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { EditionRecord, NewsletterConfig, NewsletterRecipient } from '../../src/newsletters/config.js';

const mocks = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(),
  sendTrackedBatchMarketingEmails: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'admin_01', email: 'admin@example.test', firstName: 'Ada', is_admin: true } as typeof req.user;
    next();
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));
vi.mock('../../src/notifications/email.js', () => ({
  sendMarketingEmail: mocks.sendMarketingEmail,
  sendTrackedBatchMarketingEmails: mocks.sendTrackedBatchMarketingEmails,
}));
vi.mock('../../src/slack/client.js', () => ({ sendChannelMessage: vi.fn(async () => ({ ok: false })) }));
vi.mock('../../src/routes/content.js', () => ({ proposeContentForUser: vi.fn(async () => ({ success: false })) }));
vi.mock('../../src/newsletters/send-lock.js', () => ({
  withNewsletterSendLock: async (_n: string, _e: number, work: () => Promise<unknown>) => ({ acquired: true, value: await work() }),
}));

const adminRecipient: NewsletterRecipient & Record<string, unknown> = {
  workos_user_id: 'admin_01',
  email: 'admin@example.test',
  first_name: 'Ada',
  has_slack: false,
  persona: 'molecule_builder',
  journey_stage: 'engaged',
  wg_count: 1,
};

function edition(status: EditionRecord['status']): EditionRecord {
  return {
    id: 42,
    edition_date: new Date('2026-08-18T00:00:00.000Z'),
    status,
    content: { emailSubject: 'Subject', openingTake: 'Hi.' },
    approved_by: null,
    approved_at: null,
    review_channel_id: null,
    review_message_ts: null,
    perspective_id: null,
    created_at: new Date('2026-08-18T10:00:00.000Z'),
    sent_at: null,
    send_stats: null,
  };
}

function makeConfig(current: EditionRecord, recipientLookup: NewsletterRecipient | null = adminRecipient) {
  const renderEmail = vi.fn(() => ({ html: '<p>html</p>', text: 'text' }));
  const db = {
    getCurrent: vi.fn().mockResolvedValue(current),
    getRecipients: vi.fn().mockResolvedValue([adminRecipient]),
    getRecipientByUserId: vi.fn().mockResolvedValue(recipientLookup),
    getUserWorkingGroupMap: vi.fn().mockResolvedValue(new Map([['admin_01', ['Signals WG']]])),
    markSent: vi.fn().mockResolvedValue(true),
  };
  const config = {
    id: 'the_prompt',
    name: 'The Prompt',
    emailCategory: 'the_prompt',
    announcementChannelEnvVar: 'UNSET_TEST_CHANNEL',
    editableFields: [],
    cadence: { generateHourET: 7, sendHourET: 10, shouldRunToday: () => false },
    sections: [],
    db,
    renderEmail,
    renderSlack: vi.fn(),
    generateSubject: () => 'Subject',
    buildMarkdown: () => '',
    extractTags: () => [],
  } as unknown as NewsletterConfig;
  return { config, db, renderEmail };
}

async function makeApp(config: NewsletterConfig) {
  const { createNewsletterAdminRoutes } = await import('../../src/newsletters/admin-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/newsletters/the_prompt', createNewsletterAdminRoutes(config));
  return app;
}

describe('admin test send renders like the real send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMarketingEmail.mockResolvedValue(true);
    mocks.sendTrackedBatchMarketingEmails.mockImplementation(async (batch: Array<{ render: (id: string) => unknown }>) => {
      for (const email of batch) email.render('real-tracking-id');
      return { sent: batch.length, failed: 0 };
    });
  });

  it('renders the test for the requesting admin with name, working groups, persona and segment', async () => {
    const { config, db, renderEmail } = makeConfig(edition('draft'));
    const app = await makeApp(config);

    const res = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/test-send')
      .send({ email: 'inbox@example.test' });

    expect(res.status).toBe(200);
    expect(db.getRecipientByUserId).toHaveBeenCalledWith('admin_01');
    const args = renderEmail.mock.calls[0] as unknown[];
    expect(args[1]).toBe('test');
    expect(args[3]).toBe('website_only');
    expect(args[4]).toBe('Ada');
    expect(args[5]).toEqual(['Signals WG']);
    expect(args[6]).toBe('builder');
    expect(args[7]).toBe(adminRecipient);
    expect(mocks.sendMarketingEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'inbox@example.test',
      subject: '[TEST] Subject',
    }));
  });

  it('passes the same personalisation arguments as the real send for that admin', async () => {
    const test = makeConfig(edition('draft'));
    const app = await makeApp(test.config);
    await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/test-send')
      .send({ email: 'inbox@example.test' });

    const real = makeConfig(edition('approved'));
    const { sendNewsletter } = await import('../../src/newsletters/send-pipeline.js');
    await sendNewsletter(real.config, edition('approved'));

    const testArgs = [...(test.renderEmail.mock.calls[0] as unknown[])];
    const realArgs = [...(real.renderEmail.mock.calls[0] as unknown[])];
    // Only the tracking id differs between a test send and the real send.
    testArgs.splice(1, 1);
    realArgs.splice(1, 1);
    expect(testArgs).toEqual(realArgs);
  });

  it('falls back to the admin name when there is no recipient record', async () => {
    const { config, renderEmail } = makeConfig(edition('draft'), null);
    const app = await makeApp(config);
    await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/test-send')
      .send({ email: 'inbox@example.test' });
    const args = renderEmail.mock.calls[0] as unknown[];
    expect(args[4]).toBe('Ada');
    expect(args[3]).toBe('both');
  });
});
