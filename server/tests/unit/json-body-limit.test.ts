import { describe, expect, it } from 'vitest';
import { jsonBodyLimitForPath } from '../../src/utils/json-body-limit.js';

describe('JSON transport body limits', () => {
  it('uses tight limits for dynamic SI model and Addie feedback routes', () => {
    expect(jsonBodyLimitForPath('/api/si/sessions/si_123/messages')).toBe('32kb');
    expect(jsonBodyLimitForPath('/api/si/sessions/si_123/messages/stream')).toBe('32kb');
    expect(jsonBodyLimitForPath('/api/addie/chat/thread-123/feedback')).toBe('16kb');
    expect(jsonBodyLimitForPath('/api/me/member-profile')).toBe('10mb');
    expect(jsonBodyLimitForPath('/api/json/validate-upload')).toBe('16kb');
  });

  // adcp#8199 review: the verifier is reachable bare (training-agent host) and
  // under the main app's /api/training-agent mount. Express routing is
  // case-insensitive and tolerates one trailing slash, so every spelling that
  // reaches the handler must get the tight cap.
  it.each([
    '/governance/creative-features/mcp',
    '/governance/creative-features/mcp/',
    '/api/training-agent/governance/creative-features/mcp',
    '/api/training-agent/governance/creative-features/mcp/',
    '/Governance/Creative-Features/MCP',
    '/API/Training-Agent/Governance/Creative-Features/MCP',
  ])('caps the public creative-features verifier body at %s', (path) => {
    expect(jsonBodyLimitForPath(path)).toBe('16kb');
  });

  it.each([
    '/api/training-agent/governance/mcp',
    '/api/training-agent/sales/mcp',
    '/governance/creative-features/mcp/extra',
    '/api/training-agent/governance/creative-features/mcp/extra',
    '/api/other/governance/creative-features/mcp',
    '/api/training-agent',
    '/',
  ])('does not apply the verifier cap to %s', (path) => {
    expect(jsonBodyLimitForPath(path)).toBe('10mb');
  });
});
