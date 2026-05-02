import { describe, it, expect } from 'vitest';
import { gateAgentVisibilityForCaller } from '../../src/services/agent-visibility-gate.js';

describe('gateAgentVisibilityForCaller — health_check_url', () => {
  it('preserves a valid https health_check_url', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'https://agent.example.com/health' }],
      false,
    );
    expect(agents[0].health_check_url).toBe('https://agent.example.com/health');
  });

  it('preserves http health_check_url (dev / loopback parity)', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'http://localhost:8080', visibility: 'private', health_check_url: 'http://localhost:8080/health' }],
      false,
    );
    expect(agents[0].health_check_url).toBe('http://localhost:8080/health');
  });

  it('drops malformed URLs silently', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'not a url' }],
      false,
    );
    expect(agents[0].health_check_url).toBeUndefined();
  });

  it('drops non-http(s) protocols (file://, javascript:, etc.)', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'file:///etc/passwd' }],
      false,
    );
    expect(agents[0].health_check_url).toBeUndefined();
  });

  it('omits the field when not provided', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private' }],
      false,
    );
    expect(agents[0]).not.toHaveProperty('health_check_url');
  });
});
