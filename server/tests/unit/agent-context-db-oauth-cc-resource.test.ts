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

  describe('saveOAuthClientCredentials', () => {
    it('stores an array resource as arr_v1:-prefixed JSON text in oauth_cc_resource', async () => {
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
      expect(params[5]).toBe('arr_v1:["https://api1.example.com","https://api2.example.com"]');
    });

    it('stores a scalar that starts with "json1:" as the raw string (no reencoding)', async () => {
      // The literal scalar `json1:["https://a"]` must survive save→load unchanged.
      // Arrays use arr_v1: prefix; the json1: scheme is stored as-is and decoded as scalar.
      mockGetById();
      mockedEncrypt.mockReturnValueOnce({ encrypted: 'enc', iv: 'iv' });
      mockUpdate();

      const literalScalar = 'json1:["https://a"]';
      await db.saveOAuthClientCredentials('ctx_1', {
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'client_abc',
        client_secret: 'secret',
        resource: literalScalar,
      });

      const updateCall = mockedQuery.mock.calls[1];
      const params = updateCall[1] as unknown[];
      expect(params[5]).toBe(literalScalar); // stored verbatim, not encoded
    });

    it('stores a scalar resource as the raw string (no JSON encoding)', async () => {
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
      expect(params[5]).toBe('https://api.example.com');
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
  });

  // ── Load: TEXT column decoding ────────────────────────

  describe('getOAuthClientCredentialsByOrgAndUrl', () => {
    it('decodes an arr_v1:-prefixed JSON array from oauth_cc_resource into a string[]', async () => {
      mockLoadRow({ oauth_cc_resource: 'arr_v1:["https://api1.example.com","https://api2.example.com"]' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds).not.toBeNull();
      expect(creds!.resource).toEqual(['https://api1.example.com', 'https://api2.example.com']);
    });

    it('decodes legacy json1:-prefixed data as a scalar string (no backward-compat decode)', async () => {
      // Any row written with the old draft json1: encoding is returned verbatim
      // as a scalar string. Callers that need array semantics must re-save via
      // saveOAuthClientCredentials to pick up the arr_v1: prefix.
      const legacy = 'json1:["https://api1.example.com","https://api2.example.com"]';
      mockLoadRow({ oauth_cc_resource: legacy });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe(legacy);
    });

    it('round-trips a scalar whose text starts with "json1:" unchanged (scheme-URI collision guard)', async () => {
      // json1: is a valid RFC 3986 URI scheme — a scalar resource whose text
      // starts with it must decode back to the original string, not be
      // mis-decoded as an array. Because arrays use the arr_v1: prefix (which
      // cannot appear in a valid URI scheme due to the "_" character), there is
      // no decode collision.
      const literalScalar = 'json1:["https://a"]';
      mockLoadRow({ oauth_cc_resource: literalScalar });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe(literalScalar); // scalar, not ['https://a']
    });

    it('keeps a scalar resource URI as a string (no json1: prefix)', async () => {
      mockLoadRow({ oauth_cc_resource: 'https://api.example.com' });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBe('https://api.example.com');
    });

    it('passes through any non-arr_v1: column value as a plain scalar', async () => {
      for (const raw of ['json1:[not-json', 'json1:[1,2,3]', '["legacy-scalar"]']) {
        vi.clearAllMocks();
        db = new AgentContextDatabase();
        mockLoadRow({ oauth_cc_resource: raw });
        mockedDecrypt.mockReturnValueOnce('secret-plaintext');

        const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
        expect(creds!.resource).toBe(raw);
      }
    });

    it('omits resource when oauth_cc_resource is null', async () => {
      mockLoadRow({ oauth_cc_resource: null });
      mockedDecrypt.mockReturnValueOnce('secret-plaintext');

      const creds = await db.getOAuthClientCredentialsByOrgAndUrl('org_abc', 'https://agent.example.com');
      expect(creds!.resource).toBeUndefined();
    });
  });
});
