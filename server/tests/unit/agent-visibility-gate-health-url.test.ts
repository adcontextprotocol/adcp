import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gateAgentVisibilityForCaller } from '../../src/services/agent-visibility-gate.js';

describe('gateAgentVisibilityForCaller — health_check_url SSRF guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => { process.env.NODE_ENV = 'production'; });
  afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('preserves a valid public https URL', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'https://agent.example.com/health' }],
      false,
    );
    expect(agents[0].health_check_url).toBe('https://agent.example.com/health');
  });

  it('drops cloud-metadata URLs (AWS / GCP)', () => {
    const { agents: a } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'http://169.254.169.254/latest/meta-data/' }],
      false,
    );
    expect(a[0].health_check_url).toBeUndefined();
    const { agents: b } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'http://metadata.google.internal/' }],
      false,
    );
    expect(b[0].health_check_url).toBeUndefined();
  });

  it('drops loopback in production', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: 'http://localhost:3000/health' }],
      false,
    );
    expect(agents[0].health_check_url).toBeUndefined();
  });

  it('drops RFC1918 private ranges in production', () => {
    for (const addr of ['http://10.0.0.5/health', 'http://172.16.0.1/health', 'http://192.168.1.1/health']) {
      const { agents } = gateAgentVisibilityForCaller(
        [{ url: 'https://agent.example.com', visibility: 'private', health_check_url: addr }],
        false,
      );
      expect(agents[0].health_check_url, `expected ${addr} to be dropped`).toBeUndefined();
    }
  });

  it('drops malformed URLs', () => {
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
