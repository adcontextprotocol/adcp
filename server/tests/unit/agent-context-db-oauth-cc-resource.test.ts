import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/encryption.js', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { query } from '../../src/db/client.js';
import { encrypt, decrypt } from '../../src/db/encryption.js';

const mockedQuery = vi.mocked(query);
const mockedEncrypt = vi.mocked(encrypt);
const mockedDecrypt = vi.mocked(decrypt);

/** Minimal agent context row returned by getById */
function mockGetById() {
  mockedQuery.mockResolvedValueOnce({
    rows: [{ id: 'ctx_1', organization_id: 'org_abc', agent_url: 'https://agent.example.com' }],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
}

/** Mock a successful UPDATE (the save call) */
function mockUpdate() {
  mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });
}

/** Mock a SELECT for getOAuthClientCredentialsByOrgAndUrl */
function mockLoadRow(overrides: Record<string, unknown>) {
  const base = {
    oauth_cc_token_endpoint: 'https://auth.example.com/oauth/token',
    oauth_cc_client_id: 'client_abc',
    oauth_cc_client_secret_encrypted: 'enc_secret',
    oauth_cc_client_secret_iv: 'iv_secret',
    oauth_cc_scope: null,
    oauth_cc_resource: null,
    oauth_cc_audience: null,
    oauth_cc_auth_method: null,
    ...overrides,
  };
  mockedQuery.mockResolvedValueOnce({ rows: [base], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });
}

describe('AgentContextDatabase — oauth_cc_resource save/load (RFC 8707 multi-resource)', () => {
  let db: AgentContextDatabase;

  beforeEach(() => {
    db = new AgentContextDatabase();
    vi.clearAllMocks();
  });

  // ── Save: TEXT column encoding ────────────────────────

  // ── Save: TEXT column encoding ─────────────────────────────────────────

  describe('saveOAuthClientCredentials', () => {
    it('stores an array resource with the v1a: prefix', async () => {
      mockGetById();
      mockedEncrypt.mockReturnValueOnce({ encrypted: 'enc', iv: 'iv' });
      mockUpdate();

      await db.saveOAuthClientCredentials('ctx_1', {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'secret',
        resource: ['https://api1.example.com', 'https://api2.example.com'],
      });

      const updateCall = mockedQuery.mock.calls[1];
      const params = updateCall[1] as unknown[];
      // $6 is the resource parameter (0-indexed: params[5])
      expect(params[5]).toBe('v1a:["https://api1.example.com","https://api2.example.com"]');
    });

    it('stores a scalar resource with the v1s: prefix', async () => {
      mockGetById();
      mockedEncrypt.mockReturnValueOnce({ encrypted: 'enc', iv: 'iv' });
      mockUpdate();

      await db.saveOAuthClientCredentials('ctx_1', {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'secret',
        resource: 'https://api.example.com',
      });

      const updateCall = mockedQuery.mock.calls[1];
      const params = updateCall[1] as unknown[];
      expect(params[5]).toBe('v1s:https://api.example.com');
    });

    it('stores null when resource is absent', async () => {
      mockGetById();
      mockedEncrypt.mockReturnValueOnce({ encrypted: 'enc', iv: 'iv' });
      mockUpdate();

      await db.saveOAuthClientCredentials('ctx_1', {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'secret',
      });

      const updateCall = mockedQuery.mock.calls[1];
      const params = updateCall[1] as unknown[];
      expect(params[5]).toBeNull();
    });

    it('collision: scalar resource starting with "v1a:" is stored as v1s:v1a:...', async () => {
      // Proves codec is disjoint: a scalar whose text starts with "v1a:" is wrapped
      // in v1s: so the reader never tries to JSON-parse it.
      mockGetById();
      mockedEncrypt.mockReturnValueOnce({ encrypted: 'enc', iv: 'iv' });
      mockUpdate();

      await db.saveOAuthClientCredentials('ctx_1', {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'secret',
        resource: 'v1a:["https://a"]',
      });

      const updateCall = mockedQuery.mock.calls[1];
      const params = updateCall[1] as unknown[];
      expect(params[5]).toBe('v1s:v1a:["https://a"]');
    });
  });

  // ── Load: TEXT column decoding ──────────────────────────────────────────

  describe('getOAuthClientCredentialsByOrgAndUrl', () => {
    it('decodes v1a:-prefixed column into string[]', async () => {
      mockLoadRow({ oauth_cc_resource: 'v1a:["https://api1.example.com","https://api2.example.com"]' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds).not.toBeNull();
      expect(creds!.resource).toEqual(['https://api1.example.com', 'https://api2.example.com']);
    });

    it('decodes v1s:-prefixed column into a plain scalar string', async () => {
      mockLoadRow({ oauth_cc_resource: 'v1s:https://api.example.com' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('https://api.example.com');
    });

    it('collision: v1s:v1a:[...] decodes as the scalar "v1a:[...]" (not an array)', async () => {
      mockLoadRow({ oauth_cc_resource: 'v1s:v1a:["https://a"]' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('v1a:["https://a"]');
    });

    it('falls back to raw string when v1a: payload is not valid JSON', async () => {
      mockLoadRow({ oauth_cc_resource: 'v1a:{not-json' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('v1a:{not-json');
    });

    it('falls back to raw string when v1a: payload parses to a non-string-array', async () => {
      mockLoadRow({ oauth_cc_resource: 'v1a:[1,2,3]' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('v1a:[1,2,3]');
    });

    // ── untagged / legacy rows ───────────────────────────────────────────

    it('untagged bare scalar passes through unchanged', async () => {
      mockLoadRow({ oauth_cc_resource: 'https://api.example.com' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('https://api.example.com');
    });

    it('untagged json1: row is treated as a bare scalar (not decoded as array)', async () => {
      // json1: encoding never shipped to main, so no production array rows use it.
      // A bare "json1:..." value is read back as-is — the same as any other untagged string.
      mockLoadRow({ oauth_cc_resource: 'json1:["https://api1.example.com","https://api2.example.com"]' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('json1:["https://api1.example.com","https://api2.example.com"]');
    });

    it('omits resource when oauth_cc_resource is null', async () => {
      mockLoadRow({ oauth_cc_resource: null });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBeUndefined();
    });
  });
});
