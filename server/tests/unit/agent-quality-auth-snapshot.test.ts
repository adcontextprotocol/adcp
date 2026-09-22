import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), getClientWithDeadline: vi.fn() }));
vi.mock('../../src/db/encryption.js', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));

import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { AgentQualityEvaluationLeaseLostError } from '../../src/db/agent-quality-evaluation-db.js';
import { query, getClientWithDeadline } from '../../src/db/client.js';
import { decrypt } from '../../src/db/encryption.js';

const orgId = 'org_snapshot';
const agentUrl = 'https://agent.example.com/mcp';
const db = new AgentContextDatabase();
const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
const oauthRow = {
  id: 'context-one',
  oauth_access_token_encrypted: 'access-generation-one',
  oauth_access_token_iv: 'access-iv-one',
  oauth_refresh_token_encrypted: 'refresh-generation-one',
  oauth_refresh_token_iv: 'refresh-iv-one',
  oauth_client_id: 'public-client',
  oauth_registered_redirect_uri: 'https://example.com/callback',
};
const ccRow = {
  id: 'context-one',
  oauth_cc_token_endpoint: 'https://auth.example.com/token',
  oauth_cc_client_id: 'service-client',
  oauth_cc_client_secret_encrypted: 'secret-generation-one',
  oauth_cc_client_secret_iv: 'secret-iv-one',
  oauth_cc_resource: 'v1a:["https://agent.example.com/resource"]',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(decrypt).mockImplementation(encrypted => `decrypted:${encrypted}`);
});

describe('evaluation auth snapshot', () => {
  it('binds decrypted OAuth tokens and client to their exact single-row snapshot', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([oauthRow]) as never);
    const first = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('organization_id = $1 AND agent_url = $2'), [orgId, agentUrl]);
    expect(first?.auth).toEqual({
      type: 'oauth',
      tokens: { access_token: 'decrypted:access-generation-one', refresh_token: 'decrypted:refresh-generation-one' },
      client: { client_id: 'public-client' },
    });
    expect(first?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first?.credentialFingerprint)).not.toContain('decrypted');

    vi.mocked(query).mockResolvedValueOnce(result([{ ...oauthRow, oauth_access_token_encrypted: 'access-generation-two', oauth_access_token_iv: 'access-iv-two' }]) as never);
    const rotated = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(rotated?.credentialFingerprint).not.toBe(first?.credentialFingerprint);
  });

  it('keeps identity stable across replica reads and SDK in-memory token refresh', async () => {
    vi.mocked(query).mockResolvedValue(result([oauthRow]) as never);
    const first = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    if (first?.auth.type !== 'oauth') throw new Error('Expected OAuth');
    first.auth.tokens.access_token = 'sdk-refreshed-in-memory';
    const second = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(second?.credentialFingerprint).toBe(first.credentialFingerprint);
  });

  it('fingerprints authorization-code tokens when both OAuth modes are stored', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([{ ...ccRow, ...oauthRow }]) as never);
    const first = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(first?.auth.type).toBe('oauth');
    vi.mocked(query).mockResolvedValueOnce(result([{ ...ccRow, ...oauthRow, oauth_cc_client_secret_encrypted: 'unused-cc-secret-two' }]) as never);
    const unusedRotation = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(unusedRotation?.credentialFingerprint).toBe(first?.credentialFingerprint);
    vi.mocked(query).mockResolvedValueOnce(result([{ ...ccRow, ...oauthRow, oauth_refresh_token_encrypted: 'new-principal-grant' }]) as never);
    const reauthorized = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(reauthorized?.credentialFingerprint).not.toBe(first?.credentialFingerprint);
  });

  it('returns CC configuration and changes identity when the saved secret rotates', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([ccRow]) as never);
    const first = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(first?.auth).toMatchObject({ type: 'oauth_client_credentials', credentials: { client_secret: 'decrypted:secret-generation-one', resource: ['https://agent.example.com/resource'] } });
    vi.mocked(query).mockResolvedValueOnce(result([{ ...ccRow, oauth_cc_client_secret_iv: 'secret-iv-two' }]) as never);
    const second = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(second?.credentialFingerprint).not.toBe(first?.credentialFingerprint);
  });

  it('preserves static precedence and malformed Basic fallback using the same row', async () => {
    const row = { ...oauthRow, auth_type: 'bearer', auth_token_encrypted: 'static-secret', auth_token_iv: 'static-iv' };
    vi.mocked(query).mockResolvedValueOnce(result([row]) as never);
    const staticAuth = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(staticAuth).toMatchObject({ source: 'saved', auth: { type: 'bearer', token: 'decrypted:static-secret' } });
    vi.mocked(query).mockResolvedValueOnce(result([{ ...row, auth_type: 'basic' }]) as never);
    const fallback = await db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl);
    expect(fallback?.auth.type).toBe('oauth');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('fails closed on decryption failure and returns no credentials for an absent org row', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([oauthRow]) as never);
    vi.mocked(decrypt).mockImplementation(() => { throw new Error('ciphertext invalid'); });
    await expect(db.getEvaluationAuthByOrgAndUrl(orgId, agentUrl)).rejects.toThrow('ciphertext invalid');
    vi.mocked(query).mockResolvedValueOnce(result() as never);
    await expect(db.getEvaluationAuthByOrgAndUrl('other-org', agentUrl)).resolves.toBeNull();
  });
});

describe('legacy evaluation audit fence', () => {
  const input = {
    agent_context_id: 'context-one', scenario: 'quality_evaluation', overall_passed: false,
    steps_passed: 0, steps_failed: 1,
    agent_quality_evaluation_id: 'evaluation-one', agent_quality_evaluation_lease_token: 'lease-one',
  };

  function clientWithFences(firstLive: boolean, finalLive: boolean) {
    let fences = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT 1 FROM addie_agent_quality_evaluations')) {
          fences += 1;
          return result((fences === 1 ? firstLive : finalLive) ? [{}] : []);
        }
        if (sql.includes('INSERT INTO agent_test_history')) return result([{ id: 'history-one' }]);
        return result();
      }),
      release: vi.fn(),
    };
    vi.mocked(getClientWithDeadline).mockResolvedValue(client as never);
    return client;
  }

  it('commits only after checking the live clock before and after audit writes', async () => {
    const client = clientWithFences(true, true);
    await expect(db.recordTest(input)).resolves.toMatchObject({ id: 'history-one' });
    const sql = client.query.mock.calls.map(([text]) => text);
    expect(sql.filter(text => text.includes('lease_expires_at > clock_timestamp()'))).toHaveLength(2);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it.each([[false, true], [true, false]])('rolls back when the lease fence is lost (%s, %s)', async (initial, final) => {
    const client = clientWithFences(initial, final);
    await expect(db.recordTest(input)).rejects.toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
});
