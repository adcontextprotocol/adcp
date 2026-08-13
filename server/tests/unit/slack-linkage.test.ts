import { describe, expect, it } from 'vitest';
import { hasActiveSlackLink } from '../../src/utils/slack-linkage.js';

describe('hasActiveSlackLink', () => {
  it('requires a mapped, non-deleted Slack account', () => {
    expect(hasActiveSlackLink(null)).toBe(false);
    expect(hasActiveSlackLink({
      slack_user_id: 'U123',
      mapping_status: 'unmapped',
      slack_is_deleted: false,
    })).toBe(false);
    expect(hasActiveSlackLink({
      slack_user_id: 'U123',
      mapping_status: 'mapped',
      slack_is_deleted: true,
    })).toBe(false);
    expect(hasActiveSlackLink({
      slack_user_id: 'U123',
      mapping_status: 'mapped',
      slack_is_deleted: false,
    })).toBe(true);
  });
});
