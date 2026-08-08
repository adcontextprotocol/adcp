import { describe, expect, it } from 'vitest';
import { jsonBodyLimitForPath } from '../../src/utils/json-body-limit.js';

describe('JSON transport body limits', () => {
  it('uses tight limits for dynamic SI model and Addie feedback routes', () => {
    expect(jsonBodyLimitForPath('/api/si/sessions/si_123/messages')).toBe('32kb');
    expect(jsonBodyLimitForPath('/api/si/sessions/si_123/messages/stream')).toBe('32kb');
    expect(jsonBodyLimitForPath('/api/addie/chat/thread-123/feedback')).toBe('16kb');
    expect(jsonBodyLimitForPath('/api/me/member-profile')).toBe('10mb');
  });
});
