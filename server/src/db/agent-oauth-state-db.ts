/** Private encrypted credential state for owner OAuth persistence.
 * No SQL lock spans authorization-server HTTP. CAS prevents stale persistence;
 * it does not coordinate concurrent refresh-token spending.
 */
import { query } from './client.js';
import { encrypt } from './encryption.js';
import type { OAuthClient, OAuthTokens } from './agent-context-db.js';

const STATE_FIELDS = [
  'id', 'organization_id', 'agent_url', 'protocol', 'auth_type',
  'auth_token_encrypted', 'auth_token_iv', 'auth_token_hint',
  'oauth_access_token_encrypted', 'oauth_access_token_iv',
  'oauth_refresh_token_encrypted', 'oauth_refresh_token_iv',
  'oauth_token_expires_at', 'oauth_token_issuer',
  'oauth_client_id', 'oauth_client_secret_encrypted', 'oauth_client_secret_iv',
  'oauth_registered_redirect_uri', 'oauth_client_issuer',
  'oauth_cc_token_endpoint', 'oauth_cc_client_id', 'oauth_cc_client_secret_encrypted',
  'oauth_cc_client_secret_iv', 'oauth_cc_scope', 'oauth_cc_resource',
  'oauth_cc_audience', 'oauth_cc_auth_method', 'oauth_owner_generation',
] as const;
type StateField = typeof STATE_FIELDS[number];
export type AgentOAuthState = Record<StateField, string | null> & { id: string; organization_id: string; agent_url: string };
const selectedFields = STATE_FIELDS.map(field => `${field}::text AS ${field}`).join(', ');

export class OAuthStateChangedError extends Error {
  constructor() { super('OAuth owner credentials or agent identity changed; start sign-in again'); }
}

/** Validate only the finite private shape; callback parameters cannot supply it. */
export function parseAgentOAuthState(value: unknown): AgentOAuthState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthStateChangedError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== STATE_FIELDS.length) throw new OAuthStateChangedError();
  for (const field of STATE_FIELDS) {
    if (record[field] !== null && typeof record[field] !== 'string') throw new OAuthStateChangedError();
  }
  if (!record.id || !record.organization_id || !record.agent_url) throw new OAuthStateChangedError();
  return Object.fromEntries(STATE_FIELDS.map(field => [field, record[field]])) as AgentOAuthState;
}

function comparison(state: AgentOAuthState, offset = 0): { sql: string; values: (string | null)[] } {
  return {
    sql: STATE_FIELDS.map((field, index) => `${field}::text IS NOT DISTINCT FROM $${offset + index + 1}`).join(' AND '),
    values: STATE_FIELDS.map(field => state[field]),
  };
}

export async function captureAgentOAuthState(id: string, org: string, url: string): Promise<AgentOAuthState> {
  const result = await query(`SELECT ${selectedFields} FROM agent_contexts
    WHERE id = $1 AND organization_id = $2 AND agent_url = $3`, [id, org, url]);
  return parseAgentOAuthState(result.rows[0]);
}

export async function assertAgentOAuthState(state: AgentOAuthState): Promise<void> {
  const expected = comparison(parseAgentOAuthState(state));
  const result = await query(`SELECT id FROM agent_contexts WHERE ${expected.sql}`, expected.values);
  if (result.rows.length !== 1) throw new OAuthStateChangedError();
}

function issuerMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  // The SDK has validated the issuer before passing a newly issued grant here.
  // Retain MCP's narrow slash tolerance, never compare only host/origin.
  return a === b || (a.endsWith('/') && a.slice(0, -1) === b) || (b.endsWith('/') && b.slice(0, -1) === a);
}

function encryptedTokens(tokens: OAuthTokens, org: string, prior?: AgentOAuthState): Record<string, string | null> {
  if (!tokens.access_token || !tokens.issuer) throw new OAuthStateChangedError();
  const access = encrypt(tokens.access_token, org);
  const refresh = tokens.refresh_token ? encrypt(tokens.refresh_token, org) : undefined;
  return {
    oauth_access_token_encrypted: access.encrypted, oauth_access_token_iv: access.iv,
    // An omitted replacement retains the already-bound prior refresh token.
    oauth_refresh_token_encrypted: refresh?.encrypted ?? prior?.oauth_refresh_token_encrypted ?? null,
    oauth_refresh_token_iv: refresh?.iv ?? prior?.oauth_refresh_token_iv ?? null,
    oauth_token_expires_at: tokens.expires_at?.toISOString() ?? null,
    oauth_token_issuer: tokens.issuer,
  };
}

async function replaceState(state: AgentOAuthState, updates: Record<string, string | null>, advanceOwner = false): Promise<AgentOAuthState> {
  const names = Object.keys(updates);
  const allowed: readonly string[] = STATE_FIELDS;
  if (names.some(name => !allowed.includes(name))) throw new OAuthStateChangedError();
  const expected = comparison(parseAgentOAuthState(state), names.length);
  const result = await query(`UPDATE agent_contexts SET
    ${names.map((name, index) => `${name} = $${index + 1}`).join(', ')},
    ${advanceOwner ? 'oauth_owner_generation = oauth_owner_generation + 1,' : ''} updated_at = NOW()
    WHERE ${expected.sql} RETURNING ${selectedFields}`,
  [...names.map(name => updates[name]), ...expected.values]);
  if (result.rows.length !== 1) throw new OAuthStateChangedError();
  return parseAgentOAuthState(result.rows[0]);
}

/** Not attached to background providers: durable CAS alone cannot fence spending. */
export async function replaceOAuthTokensIfUnchanged(state: AgentOAuthState, tokens: OAuthTokens): Promise<AgentOAuthState> {
  if (!issuerMatches(state.oauth_token_issuer, tokens.issuer) ||
      !issuerMatches(state.oauth_client_issuer, tokens.issuer) || !state.oauth_client_id) {
    throw new OAuthStateChangedError();
  }
  return replaceState(state, encryptedTokens(tokens, state.organization_id, state));
}

/** One atomic fresh-owner registration + grant replacement; old bytes stay until here. */
export async function completeOwnerOAuthIfUnchanged(
  state: AgentOAuthState, client: OAuthClient, tokens: OAuthTokens, redirectUri: string,
): Promise<AgentOAuthState> {
  if (!client.client_id || !issuerMatches(client.issuer, tokens.issuer) || !redirectUri) throw new OAuthStateChangedError();
  const secret = client.client_secret ? encrypt(client.client_secret, state.organization_id) : undefined;
  return replaceState(state, {
    ...encryptedTokens(tokens, state.organization_id),
    oauth_client_id: client.client_id,
    oauth_client_secret_encrypted: secret?.encrypted ?? null, oauth_client_secret_iv: secret?.iv ?? null,
    oauth_client_issuer: client.issuer ?? null, oauth_registered_redirect_uri: redirectUri,
  }, true);
}
