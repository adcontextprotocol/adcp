import { describe, expect, it } from 'vitest';
import {
  issueAnonymousSessionCapability,
  verifyAnonymousSessionCapability,
} from '../../src/routes/helpers/anonymous-session-capability.js';

describe('anonymous session capabilities', () => {
  it('binds a signed capability to its audience and subject', () => {
    const token = issueAnonymousSessionCapability('si-session-owner', 'si_session_123');

    expect(verifyAnonymousSessionCapability(token, 'si-session-owner', 'si_session_123')?.sub)
      .toBe('si_session_123');
    expect(verifyAnonymousSessionCapability(token, 'other-audience', 'si_session_123')).toBeNull();
    expect(verifyAnonymousSessionCapability(token, 'si-session-owner', 'si_other')).toBeNull();
  });

  it('rejects tampering and expired capabilities', () => {
    const token = issueAnonymousSessionCapability('si-session-owner', 'si_session_123');
    const expired = issueAnonymousSessionCapability('si-session-owner', 'si_session_123', -1);

    expect(verifyAnonymousSessionCapability(`${token}x`, 'si-session-owner')).toBeNull();
    expect(verifyAnonymousSessionCapability(expired, 'si-session-owner')).toBeNull();
  });
});
