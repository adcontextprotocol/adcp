import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { EditionRecord, NewsletterConfig } from '../../src/newsletters/config.js';

const mocks = vi.hoisted(() => ({
  sendNewsletter: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'admin_01', email: 'admin@example.test', is_admin: true } as typeof req.user;
    next();
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../src/newsletters/send-pipeline.js', () => ({
  sendNewsletter: mocks.sendNewsletter,
}));

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

function edition(status: EditionRecord['status']): EditionRecord {
  return {
    id: 42,
    edition_date: new Date('2026-08-18T00:00:00.000Z'),
    status,
    content: { emailSubject: 'Test edition' },
    approved_by: status === 'draft' ? null : 'admin@example.test',
    approved_at: status === 'draft' ? null : new Date('2026-08-18T12:00:00.000Z'),
    review_channel_id: null,
    review_message_ts: null,
    perspective_id: null,
    created_at: new Date('2026-08-18T10:00:00.000Z'),
    sent_at: status === 'sent' ? new Date('2026-08-18T12:05:00.000Z') : null,
    send_stats: null,
  };
}

function makeConfig(current: EditionRecord) {
  const approved = edition('approved');
  const sent = edition('sent');
  const db = {
    getCurrent: vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(sent),
    approve: vi.fn().mockResolvedValue(approved),
  };
  const config = {
    id: 'the_prompt',
    name: 'The Prompt',
    author: 'Addie',
    palette: { primary: '#000', light: '#fff', dark: '#111' },
    editableFields: [],
    cadence: { generateHourET: 8, sendHourET: 10, shouldRunToday: () => true },
    sections: [],
    db,
    generateSubject: () => 'Test edition',
  } as unknown as NewsletterConfig;
  return { config, db, approved };
}

async function makeApp(config: NewsletterConfig) {
  const { createNewsletterAdminRoutes } = await import('../../src/newsletters/admin-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/newsletters/the_prompt', createNewsletterAdminRoutes(config));
  return app;
}

describe('newsletter admin send now', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendNewsletter.mockResolvedValue({ sent: 12, outcome: 'delivered' });
  });

  it('approves a draft before sending it immediately', async () => {
    const { config, db, approved } = makeConfig(edition('draft'));
    const app = await makeApp(config);

    const response = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/send-now');

    expect(response.status).toBe(200);
    expect(db.approve).toHaveBeenCalledWith(42, 'admin@example.test');
    expect(mocks.sendNewsletter).toHaveBeenCalledWith(config, approved);
    expect(response.body.result).toEqual({ sent: 12, outcome: 'delivered' });
  });

  it('sends an already approved edition without approving it again', async () => {
    const current = edition('approved');
    const { config, db } = makeConfig(current);
    const app = await makeApp(config);

    const response = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/send-now');

    expect(response.status).toBe(200);
    expect(db.approve).not.toHaveBeenCalled();
    expect(mocks.sendNewsletter).toHaveBeenCalledWith(config, current);
  });

  it('does not send when draft approval loses a status race', async () => {
    const { config, db } = makeConfig(edition('draft'));
    db.approve.mockResolvedValueOnce(null);
    const app = await makeApp(config);

    const response = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/send-now');

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('status changed');
    expect(mocks.sendNewsletter).not.toHaveBeenCalled();
  });

  it('does not resend a completed edition', async () => {
    const { config, db } = makeConfig(edition('sent'));
    const app = await makeApp(config);

    const response = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/send-now');

    expect(response.status).toBe(400);
    expect(db.approve).not.toHaveBeenCalled();
    expect(mocks.sendNewsletter).not.toHaveBeenCalled();
  });

  it('reports a conflict when another sender holds the edition lock', async () => {
    const { config } = makeConfig(edition('approved'));
    mocks.sendNewsletter.mockResolvedValueOnce({ sent: 0, outcome: 'busy' });
    const app = await makeApp(config);

    const response = await request(app)
      .post('/api/admin/newsletters/the_prompt/editions/42/send-now');

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('already being sent');
  });

  it('shows the immediate-send action while the edition is still a draft', async () => {
    const html = await readFile(new URL('../../public/admin-newsletter.html', import.meta.url), 'utf8');

    expect(html).toContain("status === 'draft' ? `<button class=\"btn btn-nl\" onclick=\"sendNow(event)\">Approve and send now</button>` : ''");
    expect(html).toContain('Approve this draft and send it now?');
    expect(html).toContain('btn.textContent = originalButtonText');
  });
});
