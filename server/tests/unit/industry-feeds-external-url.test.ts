import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ query: queryMock }));

import {
  createEmailPerspective,
  createRssPerspective,
} from '../../src/db/industry-feeds-db.js';

describe('industry feed external URL validation', () => {
  beforeEach(() => queryMock.mockReset());

  it('skips an RSS item with a non-HTTP link before querying the database', async () => {
    await expect(createRssPerspective({
      feed_id: 1,
      feed_name: 'Test feed',
      guid: 'unsafe-rss-item',
      title: 'Unsafe RSS item',
      link: 'javascript:alert(document.domain)',
    })).resolves.toBeNull();

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('ignores unsafe email links and stores the newsletter as an article', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'perspective-id' }] });

    await expect(createEmailPerspective({
      feed_id: 2,
      feed_name: 'Test newsletter',
      message_id: 'unsafe-email-link',
      subject: 'Newsletter subject',
      from_email: 'sender@example.com',
      received_at: new Date('2026-01-01T00:00:00Z'),
      text_content: 'Newsletter body',
      links: [{ url: 'data:text/html,<script>alert(1)</script>' }],
    })).resolves.toBe('perspective-id');

    const parameters = queryMock.mock.calls[0][1];
    expect(parameters[1]).toBe('article');
    expect(parameters[5]).toBeNull();
  });

  it('uses the first safe HTTP link after discarding unsafe candidates', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'perspective-id' }] });

    await createEmailPerspective({
      feed_id: 3,
      feed_name: 'Test newsletter',
      message_id: 'safe-email-link',
      subject: 'Newsletter subject',
      from_email: 'sender@example.com',
      received_at: new Date('2026-01-01T00:00:00Z'),
      links: [
        { url: 'javascript:alert(1)' },
        { url: ' https://example.com/story ' },
      ],
    });

    const parameters = queryMock.mock.calls[0][1];
    expect(parameters[1]).toBe('link');
    expect(parameters[5]).toBe('https://example.com/story');
  });
});
