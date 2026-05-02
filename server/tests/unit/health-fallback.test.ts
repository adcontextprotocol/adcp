import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '../../src/types.js';

// Pins the contract for the health_check_url fallback (adcp#3066):
//  - probe still tries MCP first
//  - on MCP failure with health_check_url set, GET it via safeFetch and
//    treat 2xx as alive
//  - fallback never populates tools_count / resources_count
//  - error classifier returns a structured { kind, message, raw }; SDK-
//    wrapped DNS errors are detected via cause-chain walk, not regex on
//    the outer message
//  - the fallback never bypasses safeFetch (DNS-rebind / private-IP guard)

// vi.hoisted lets the mocks reference shared fns without tripping vitest's
// hoisting of vi.mock() calls above other top-level code.
const { mockGetAgentInfo, mockSafeFetch } = vi.hoisted(() => ({
  mockGetAgentInfo: vi.fn(),
  mockSafeFetch: vi.fn(),
}));

vi.mock('@adcp/sdk', () => ({
  getPropertyIndex: () => ({ getAgentAuthorizations: () => null }),
  AdCPClient: class {
    agent() {
      return { executeTask: vi.fn(), getAgentInfo: mockGetAgentInfo };
    }
  },
}));

vi.mock('../../src/db/outbound-log-db.js', () => ({
  logOutboundRequest: vi.fn(),
}));

// Stub the SSRF-safe fetch used by tryHealthCheckFallback. Mocking at this
// boundary keeps tests honest about which entry point the fallback uses —
// if the implementation regresses to plain `fetch`, the mock stays untouched
// and the fallback test fails.
vi.mock('../../src/utils/url-security.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url-security.js')>(
    '../../src/utils/url-security.js',
  );
  return {
    ...actual,
    safeFetch: mockSafeFetch,
  };
});

import { HealthChecker, classifyMCPError } from '../../src/health.js';

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
  it('flags AuthenticationRequiredError as auth_required', () => {
    const err = Object.assign(new Error('Authentication required'), { name: 'AuthenticationRequiredError' });
    const r = classifyMCPError(err);
    expect(r.kind).toBe('auth_required');
    expect(r.message).toMatch(/requires authentication/i);
    expect(r.raw).toBe('Authentication required');
  });

  it('flags WWW-Authenticate hints as auth_required', () => {
    const r = classifyMCPError(new Error('Server returned WWW-Authenticate: Bearer realm=...'));
    expect(r.kind).toBe('auth_required');
  });

  it('flags discovery failures as wrong_path', () => {
    const r = classifyMCPError(new Error('Failed to discover MCP endpoint at any of: /, /mcp, /mcp/'));
    expect(r.kind).toBe('wrong_path');
    expect(r.message).toMatch(/no mcp endpoint/i);
  });

  it('detects ENOTFOUND via direct error code', () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' });
    expect(classifyMCPError(dnsErr).kind).toBe('unreachable');
  });

  it('detects SDK-wrapped DNS errors via cause chain', () => {
    // Pins the bug found during live probing: SDK wraps DNS failures into
    // "Failed to discover MCP endpoint" outer messages. Without cause-chain
    // walking, the classifier mis-tags an unreachable host as wrong_path.
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' });
    const wrapped = new Error('Failed to discover MCP endpoint');
    (wrapped as any).cause = inner;
    expect(classifyMCPError(wrapped).kind).toBe('unreachable');
  });

  it('detects ECONNREFUSED as unreachable', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
    expect(classifyMCPError(refused).kind).toBe('unreachable');
  });

  it('does not mis-classify a tool-call 404 as wrong_path', () => {
    // The bare "404" alternation in the prior regex would have flagged this
    // as wrong_path. The tightened pattern requires the SDK's discovery
    // phrasing.
    const r = classifyMCPError(new Error('Tool returned HTTP 404 for /products'));
    expect(r.kind).toBe('unknown');
  });

  it('falls through to unknown for unrecognized errors', () => {
    const r = classifyMCPError(new Error('something weird'));
    expect(r.kind).toBe('unknown');
    expect(r.message).toMatch(/MCP connection failed/);
  });
});

describe('HealthChecker.tryMCP — health_check_url fallback', () => {
  beforeEach(() => {
    mockGetAgentInfo.mockReset();
    mockSafeFetch.mockReset();
  });

  it('returns online with tools when MCP succeeds (no fallback used)', async () => {
    mockGetAgentInfo.mockResolvedValue({ tools: [{ name: 'a' }, { name: 'b' }] });
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(true);
    expect(health.tools_count).toBe(2);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('falls back to health_check_url GET when MCP fails and 2xx is returned', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    mockSafeFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(true);
    expect(health.tools_count).toBeUndefined();
    expect(health.resources_count).toBeUndefined();
    expect(health.error).toMatch(/Liveness via health_check_url/);
    expect(health.error_kind).toBe('wrong_path');
    expect(health.error_detail).toMatch(/Failed to discover/);
  });

  it('uses safeFetch with maxRedirects: 0 (no redirect-bypass to internal targets)', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    mockSafeFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const checker = new HealthChecker(0);
    await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockSafeFetch.mock.calls[0];
    expect(url).toBe('https://agent.example.com/health');
    expect(opts.maxRedirects).toBe(0);
    expect(opts.method).toBe('GET');
  });

  it('marks offline when MCP fails and health_check_url returns non-2xx', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    mockSafeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://agent.example.com/health' }));
    expect(health.online).toBe(false);
    expect(health.error_kind).toBe('wrong_path');
  });

  it('marks offline when safeFetch rejects (e.g. SSRF block)', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('Failed to discover MCP endpoint'));
    mockSafeFetch.mockRejectedValue(new Error('Connection to private or internal address is blocked'));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent({ health_check_url: 'https://internal.local/health' }));
    expect(health.online).toBe(false);
    // The MCP error remains the surfaced reason — fallback failure
    // does not leak internal-address details to the dashboard.
    expect(health.error).not.toMatch(/private or internal/);
    expect(health.error_kind).toBe('wrong_path');
  });

  it('marks offline when MCP fails and health_check_url is not configured', async () => {
    mockGetAgentInfo.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const checker = new HealthChecker(0);
    const health = await checker.checkHealth(baseAgent());
    expect(health.online).toBe(false);
    expect(health.error_kind).toBe('unreachable');
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
