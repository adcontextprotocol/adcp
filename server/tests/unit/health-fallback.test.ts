import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Agent } from '../../src/types.js';
import { classifyMCPError } from '../../src/health.js';

// Pins the contract for the health_check_url fallback (adcp#3066):
//  - probe still tries MCP first
//  - on MCP failure with health_check_url set, GET it and treat 2xx as alive
//  - fallback never populates tools_count / resources_count
//  - error classifier surfaces actionable hints for common operator mistakes
//    (wrong path, missing auth, unreachable host)

const mockGetAgentInfo = vi.fn();

vi.mock('@adcp/sdk', () => ({
  getPropertyIndex: () => ({
    getAgentAuthorizations: () => null,
  }),
  AdCPClient: class {
    agent() {
      return { executeTask: vi.fn(), getAgentInfo: mockGetAgentInfo };
    }
  },
}));

vi.mock('../../src/db/outbound-log-db.js', () => ({
  logOutboundRequest: vi.fn(),
}));

import { HealthChecker } from '../../src/health.js';

const baseAgent = (overrides: Partial<Agent> = {}): Agent => ({
  name: 'Test',
  url: 'https://agent.example.com',
  type: 'sales',
  protocol: 'mcp',
  description: '',
  mcp_endpoint: 'https://agent.example.com/mcp',
  contact: { name: '', email: '', website: '' },
  added_date: '2026-01-01',
  ...overrides,
});

describe('classifyMCPError', () => {
  it('flags AuthenticationRequiredError as auth-required with actionable message', () => {
    const err = Object.assign(new Error('401 Unauthorized'), { name: 'AuthenticationRequiredError' });
    const msg = classifyMCPError(err);
    expect(msg).toMatch(/requires authentication/i);
    expect(msg).toMatch(/auth token|client credentials/i);
  });

  it('flags WWW-Authenticate hints as auth-required even without typed error', () => {
    const msg = classifyMCPError(new Error('Server returned WWW-Authenticate: Bearer realm=...'));
    expect(msg).toMatch(/requires authentication/i);
  });

  it('flags discovery failures with sub-path hint', () => {
    const msg = classifyMCPError(new Error('Failed to discover MCP endpoint at any of: /, /mcp, /mcp/'));
    expect(msg).toMatch(/no mcp endpoint/i);
    expect(msg).toMatch(/sub-path|\/adcp\/mcp|well-known/i);
  });

  it('flags ENOTFOUND / ECONNREFUSED as unreachable', () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' });
    expect(classifyMCPError(dnsErr)).toMatch(/unreachable/i);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyMCPError(refused)).toMatch(/unreachable/i);
  });

  it('falls through to generic message for unrecognized errors', () => {
    expect(classifyMCPError(new Error('something weird'))).toMatch(/MCP connection failed/);
  });
});

describe('HealthChecker.tryMCP — health_check_url fallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetAgentInfo.mockReset();
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns online with tools when MCP succeeds (no fallback used)', async () => {
    mockGetAgentInfo.mockResolvedValue({ tools: [{ name: 'a' }, { name: 'b' }] });
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(true);
    expect(health.tools_count).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to health_check_url GET when MCP fails and 2xx is returned', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(true);
    // Liveness-only — no synthetic tools count
    expect(health.tools_count).toBeUndefined();
    expect(health.resources_count).toBeUndefined();
    // Underlying MCP failure surfaces in the error field so the dashboard
    // can still show that protocol discovery is broken.
    expect(health.error).toMatch(/Liveness via health_check_url/);
    expect(health.error).toMatch(/no mcp endpoint/i);
  });

  it('marks offline when MCP fails and health_check_url returns non-2xx', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(false);
    expect(health.error).toMatch(/no mcp endpoint/i);
  });

  it('marks offline when MCP fails and health_check_url is not configured', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent());
    expect(health.online).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
