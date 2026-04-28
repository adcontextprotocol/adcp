import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { csrfProtection } from '../../src/middleware/csrf.js';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/',
    cookies: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _cookies: Record<string, { value: string; options: unknown }>; _status: number; _body: unknown; _headers: Record<string, string> } {
  const res = {
    _cookies: {} as Record<string, { value: string; options: unknown }>,
    _status: 200,
    _body: undefined as unknown,
    _headers: {} as Record<string, string>,
    cookie(name: string, value: string, options: unknown) {
      res._cookies[name] = { value, options };
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
  };
  return res as unknown as Response & typeof res;
}

describe('csrfProtection', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  // --- Safe methods pass through ---

  it('allows GET requests without any token', () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows HEAD requests without any token', () => {
    const req = mockReq({ method: 'HEAD' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows OPTIONS requests without any token', () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // --- Authorization header bypass ---

  it('allows POST with Authorization header (API key auth)', () => {
    const req = mockReq({
      method: 'POST',
      headers: { authorization: 'Bearer some-token' } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows POST with Authorization header even when CSRF cookie/header are missing', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/some/endpoint',
      cookies: {},
      headers: { authorization: 'Bearer some-token' } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // --- Exempt paths (all prefixes and exact matches) ---

  const exemptPrefixPaths = [
    '/api/webhooks/resend',
    '/api/slack/events',
    '/api/mcp/sse',
    '/api/oauth/callback',
    '/api/si/negotiate',
    '/api/training-agent/mcp',
    '/api/creative-agent/mcp',
    '/api/addie/v1/chat/completions',
  ];

  it.each(exemptPrefixPaths)('allows POST to exempt prefix path %s', (path) => {
    const req = mockReq({ method: 'POST', path });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  const exemptExactPaths = [
    '/mcp',
    '/mcp-strict',
    '/mcp-strict-required',
    '/mcp-strict-forbidden',
    '/stripe-webhook',
    '/auth/bridge-callback',
    '/token',
    '/register',
  ];

  it.each(exemptExactPaths)('allows POST to exempt exact path %s', (path) => {
    const req = mockReq({ method: 'POST', path });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects POST to path that resembles but does not match exempt prefix', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'POST',
      path: '/api/webhook', // no trailing slash — NOT /api/webhooks/
      cookies: { 'csrf-token': token },
      headers: {} as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  // --- Valid CSRF token ---

  it('allows POST with matching cookie and header', () => {
    const token = 'a'.repeat(64); // 32 bytes hex = 64 chars
    const req = mockReq({
      method: 'POST',
      path: '/api/me/certification/modules/a1/start',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': token } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // --- Missing cookie (expired) ---

  it('rejects POST when cookie is missing and returns cookie_expired reason with fresh token', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/addie/chat/stream',
      cookies: {},
      headers: { 'x-csrf-token': 'stale-value' } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    const body = res._body as { error: string; reason: string; token: string };
    expect(body.error).toBe('CSRF validation failed');
    expect(body.reason).toBe('cookie_expired');
    expect(body.token).toHaveLength(64);
  });

  it('sets X-CSRF-Retry header when cookie is missing', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/addie/chat/stream',
      cookies: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(res._headers['X-CSRF-Retry']).toBe('true');
  });

  it('sets a fresh cookie on the response when cookie is missing', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/addie/chat/stream',
      cookies: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(res._cookies['csrf-token']).toBeDefined();
    expect(res._cookies['csrf-token'].value).toHaveLength(64);
  });

  it('returns a token in the body that matches the cookie set on the response', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/addie/chat/stream',
      cookies: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    const body = res._body as { token: string };
    expect(body.token).toBe(res._cookies['csrf-token'].value);
  });

  // --- Token mismatch ---

  it('rejects POST when header does not match cookie', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': 'b'.repeat(64) } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'CSRF validation failed', reason: 'token_mismatch' });
  });

  it('rejects POST when header is missing but cookie exists', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: { 'csrf-token': token },
      headers: {} as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'CSRF validation failed', reason: 'token_mismatch' });
  });

  // --- Cookie edge cases ---

  it('treats malformed cookie (wrong length) as missing', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: { 'csrf-token': 'too-short' },
      headers: { 'x-csrf-token': 'too-short' } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    const body = res._body as { reason: string };
    expect(body.reason).toBe('cookie_expired');
    expect(res._headers['X-CSRF-Retry']).toBe('true');
  });

  it('treats non-string cookie value as missing', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: { 'csrf-token': ['array-value'] as unknown as string },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(res._status).toBe(403);
    const body = res._body as { reason: string };
    expect(body.reason).toBe('cookie_expired');
  });

  it('handles undefined cookies gracefully', () => {
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: undefined as unknown as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(res._status).toBe(403);
    const body = res._body as { reason: string };
    expect(body.reason).toBe('cookie_expired');
  });

  // --- Cookie settings ---

  it('sets cookie with correct security options', () => {
    const req = mockReq({ method: 'GET', cookies: {} });
    const res = mockRes();
    csrfProtection(req, res, next);
    const opts = res._cookies['csrf-token'].options as Record<string, unknown>;
    expect(opts.httpOnly).toBe(false);
    expect(opts.sameSite).toBe('strict');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  // --- GET sets a cookie when missing ---

  it('sets a new cookie on GET when none exists', () => {
    const req = mockReq({ method: 'GET', cookies: {} });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._cookies['csrf-token']).toBeDefined();
    expect(res._cookies['csrf-token'].value).toHaveLength(64);
  });

  it('does not overwrite existing valid cookie on GET', () => {
    const token = 'c'.repeat(64);
    const req = mockReq({ method: 'GET', cookies: { 'csrf-token': token } });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._cookies['csrf-token']).toBeUndefined();
  });

  // --- X-CSRF-Retry only on cookie_expired, not on mismatch ---

  it('does not set X-CSRF-Retry header on token mismatch', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'POST',
      path: '/api/me/settings',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': 'b'.repeat(64) } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(res._headers['X-CSRF-Retry']).toBeUndefined();
  });

  // --- All state-changing methods validated ---

  it('validates CSRF on PUT requests', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'PUT',
      path: '/api/me/settings',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': token } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects DELETE without valid CSRF token', () => {
    const req = mockReq({
      method: 'DELETE',
      path: '/api/me/account',
      cookies: { 'csrf-token': 'a'.repeat(64) },
      headers: {} as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'CSRF validation failed', reason: 'token_mismatch' });
  });

  it('validates CSRF on PATCH requests', () => {
    const token = 'a'.repeat(64);
    const req = mockReq({
      method: 'PATCH',
      path: '/api/me/settings',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': token } as Record<string, string>,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
