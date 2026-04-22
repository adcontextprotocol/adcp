import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveMCPServerURL } from '../../src/mcp/routes.js';

describe('resolveMCPServerURL', () => {
  const originalBaseUrl = process.env.BASE_URL;
  const originalPort = process.env.PORT;
  const originalConductorPort = process.env.CONDUCTOR_PORT;

  beforeEach(() => {
    // Isolate each case from the surrounding shell env.
    delete process.env.BASE_URL;
    delete process.env.PORT;
    delete process.env.CONDUCTOR_PORT;
  });

  afterEach(() => {
    // Restore to whatever the parent process had.
    if (originalBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = originalBaseUrl;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalConductorPort === undefined) delete process.env.CONDUCTOR_PORT;
    else process.env.CONDUCTOR_PORT = originalConductorPort;
  });

  it('returns a valid BASE_URL unchanged (trailing slash stripped)', () => {
    process.env.BASE_URL = 'https://agenticadvertising.org/';
    expect(resolveMCPServerURL()).toBe('https://agenticadvertising.org');
  });

  it('returns a valid BASE_URL without trailing slash as-is', () => {
    process.env.BASE_URL = 'https://agent.example.com';
    expect(resolveMCPServerURL()).toBe('https://agent.example.com');
  });

  it('falls back when BASE_URL is unset', () => {
    expect(resolveMCPServerURL()).toBe('http://localhost:3000');
  });

  it('falls back when BASE_URL is an empty string', () => {
    process.env.BASE_URL = '';
    expect(resolveMCPServerURL()).toBe('http://localhost:3000');
  });

  it('falls back when BASE_URL is "/" — the conductor default that previously crashed HTTPServer startup', () => {
    process.env.BASE_URL = '/';
    expect(resolveMCPServerURL()).toBe('http://localhost:3000');
  });

  it('falls back when BASE_URL is whitespace-only', () => {
    process.env.BASE_URL = '   ';
    expect(resolveMCPServerURL()).toBe('http://localhost:3000');
  });

  it('falls back when BASE_URL cannot be parsed by WHATWG URL', () => {
    // Missing scheme.
    process.env.BASE_URL = 'agenticadvertising.org';
    expect(resolveMCPServerURL()).toBe('http://localhost:3000');
  });

  it('honours PORT in the fallback when BASE_URL is invalid', () => {
    process.env.PORT = '8080';
    expect(resolveMCPServerURL()).toBe('http://localhost:8080');
  });

  it('honours CONDUCTOR_PORT when PORT is absent', () => {
    process.env.CONDUCTOR_PORT = '3999';
    expect(resolveMCPServerURL()).toBe('http://localhost:3999');
  });

  it('PORT takes precedence over CONDUCTOR_PORT', () => {
    process.env.PORT = '8080';
    process.env.CONDUCTOR_PORT = '3999';
    expect(resolveMCPServerURL()).toBe('http://localhost:8080');
  });

  it('resolved URL always parses cleanly (prevents mcpAuthRouter crash)', () => {
    for (const input of [undefined, '', '/', '  ', 'not-a-url', 'https://good.example.com']) {
      if (input === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = input;
      const resolved = resolveMCPServerURL();
      expect(() => new URL(resolved)).not.toThrow();
    }
  });
});
