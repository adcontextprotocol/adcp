import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { getAttemptForUser } from '../../src/db/certification-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = 'user_attempt_owner';

describe('getAttemptForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the attempt lookup to both its ID and learner', async () => {
    const attempt = {
      id: ATTEMPT_ID,
      workos_user_id: USER_ID,
      track_id: 'S',
      module_id: 'S3',
      status: 'in_progress' as const,
      started_at: new Date().toISOString(),
      completed_at: null,
      scores: null,
      overall_score: null,
      passing: null,
      addie_thread_id: null,
      certifier_credential_id: null,
      certifier_public_id: null,
      created_at: new Date().toISOString(),
    };
    mockedQuery.mockResolvedValueOnce({ rows: [attempt] } as never);

    await expect(getAttemptForUser(ATTEMPT_ID, USER_ID)).resolves.toEqual(attempt);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND workos_user_id = $2'),
      [ATTEMPT_ID, USER_ID],
    );
  });

  it('returns null when no attempt belongs to the learner', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] } as never);

    await expect(getAttemptForUser(ATTEMPT_ID, USER_ID)).resolves.toBeNull();
  });
});
