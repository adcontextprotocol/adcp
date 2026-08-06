import { describe, expect, it } from 'vitest';
import { getSlackApiErrorCode, isPermanentDmDeliveryError } from '../../src/addie/slack-api-errors.js';

describe('Slack API error classification', () => {
  it('recognizes read-only conversations as permanent DM delivery failures', () => {
    const error = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'restricted_action_read_only_channel' },
    };

    expect(getSlackApiErrorCode(error)).toBe('restricted_action_read_only_channel');
    expect(isPermanentDmDeliveryError(error)).toBe(true);
  });

  it('leaves transient and malformed failures unclassified', () => {
    expect(isPermanentDmDeliveryError({ data: { error: 'ratelimited' } })).toBe(false);
    expect(isPermanentDmDeliveryError(new Error('network failed'))).toBe(false);
  });
});
