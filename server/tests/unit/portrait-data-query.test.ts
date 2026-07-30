import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

import { getPool, query } from '../../src/db/client.js';
import { approvePortrait, getPortraitData } from '../../src/db/portrait-db.js';

const mockedQuery = vi.mocked(query);
const mockedGetPool = vi.mocked(getPool);

describe('getPortraitData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the portrait owner needed to authorize generated previews', async () => {
    const row = {
      portrait_data: Buffer.from('portrait'),
      image_url: '/api/portraits/11111111-1111-4111-8111-111111111111.png',
      status: 'generated' as const,
      user_id: 'user_owner',
    };
    mockedQuery.mockResolvedValueOnce({ rows: [row] } as never);

    const result = await getPortraitData('11111111-1111-4111-8111-111111111111');

    expect(result).toEqual(row);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT portrait_data, image_url, status, user_id[\s\S]+status IN \('approved', 'generated'\)/),
      ['11111111-1111-4111-8111-111111111111'],
    );
  });
});

describe('approvePortrait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTransaction(updateRowCount: number) {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: updateRowCount })
        .mockResolvedValue({}),
      release: vi.fn(),
    };
    mockedGetPool.mockReturnValue({
      connect: vi.fn().mockResolvedValue(client),
    } as never);
    return client;
  }

  it('does not let an owner reapprove an admin-rejected portrait or relink it', async () => {
    const client = mockTransaction(0);

    const result = await approvePortrait(
      '11111111-1111-4111-8111-111111111111',
      'user_owner',
    );

    expect(result).toBeNull();
    expect(client.query).toHaveBeenNthCalledWith(2,
      expect.stringMatching(/WHERE id = \$1 AND user_id = \$2 AND status = 'generated'/),
      ['11111111-1111-4111-8111-111111111111', 'user_owner'],
    );
    expect(client.query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('still approves and relinks a generated portrait owned by the caller', async () => {
    const client = mockTransaction(1);
    const approved = {
      id: '11111111-1111-4111-8111-111111111111',
      user_id: 'user_owner',
      status: 'approved',
    };
    mockedQuery.mockResolvedValueOnce({ rows: [approved] } as never);

    const result = await approvePortrait(approved.id, approved.user_id);

    expect(result).toEqual(approved);
    expect(client.query).toHaveBeenNthCalledWith(2,
      expect.stringMatching(/WHERE id = \$1 AND user_id = \$2 AND status = 'generated'/),
      [approved.id, approved.user_id],
    );
    expect(client.query).toHaveBeenNthCalledWith(3,
      expect.stringContaining('UPDATE users SET portrait_id = $1'),
      [approved.id, `/api/portraits/${approved.id}.png`, approved.user_id],
    );
    expect(client.query).toHaveBeenNthCalledWith(4,
      expect.stringContaining('UPDATE member_profiles mp'),
      [approved.id, approved.user_id],
    );
    expect(client.query).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
