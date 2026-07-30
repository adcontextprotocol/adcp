/**
 * Narrow `ResolvedOwnerAuth` (server's internal auth union) down to the
 * shape `@adcp/sdk`'s `ComplyOptions.auth` / `TestOptions.auth`
 * accepts (bearer | basic | oauth).
 *
 * @adcp/sdk accepts the same auth union. Keep this seam so server call sites
 * do not import SDK-internal auth types and so future storage variants still
 * have one conversion point.
 */

import type { ResolvedOwnerAuth } from '../db/compliance-db.js';

/**
 * The subset of `ResolvedOwnerAuth` the SDK accepts. Kept as a
 * structural type so we aren't importing @adcp/sdk's internal types
 * across the boundary.
 */
export type SdkAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | {
      type: 'oauth';
      tokens: { access_token: string; refresh_token: string; expires_at?: string };
      client?: { client_id: string; client_secret?: string };
    }
  | Extract<ResolvedOwnerAuth, { type: 'oauth_client_credentials' }>;

/**
 * Narrow server-resolved auth into the SDK's accepted shape. Returns
 * `undefined` for missing auth.
 */
export async function adaptAuthForSdk(
  auth: ResolvedOwnerAuth | undefined,
  _context: { tokenEndpointLabel?: string } = {},
): Promise<SdkAuth | undefined> {
  return auth;
}

/**
 * Authentication shape for the SDK's capability-discovery preflight.
 *
 * @adcp/sdk 9.x attaches the OAuth provider after endpoint discovery, while
 * discovery itself only reads the bearer token. Preserve bearer/basic auth as
 * supplied, but expose the current OAuth access token as bearer credentials so
 * an already-authorized agent is not probed anonymously.
 */
export function authForSdkDiscoveryProbe(auth: SdkAuth | undefined): SdkAuth | undefined {
  if (auth?.type !== 'oauth') return auth;
  return { type: 'bearer', token: auth.tokens.access_token };
}

/**
 * Subset of `AgentConfig` (from `@adcp/sdk`) populated from saved auth.
 * Spread into the config literal passed to `new AdCPClient(...)` to make
 * authenticated probe / discovery / health calls. Bearer maps to
 * `auth_token`; basic maps to a pre-encoded `Authorization: Basic …`
 * header; oauth maps to the `oauth_tokens` + `oauth_client` shape the
 * SDK refreshes on 401. For oauth, also duplicate the current access token
 * into `auth_token`: @adcp/sdk runs MCP/A2A endpoint discovery before it
 * attaches the OAuth provider, and that discovery preflight only reads the
 * bearer field.
 */
export type AgentConfigAuthFields = {
  auth_token?: string;
  headers?: Record<string, string>;
  oauth_tokens?: {
    access_token: string;
    refresh_token: string;
    expires_at?: string;
  };
  oauth_client?: { client_id: string; client_secret?: string };
  oauth_client_credentials?: Extract<SdkAuth, { type: 'oauth_client_credentials' }>['credentials'];
};

export function agentConfigAuthFields(auth: SdkAuth | undefined): AgentConfigAuthFields {
  if (!auth) return {};
  switch (auth.type) {
    case 'bearer':
      return { auth_token: auth.token };
    case 'basic': {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { headers: { Authorization: `Basic ${encoded}` } };
    }
    case 'oauth': {
      const fields: AgentConfigAuthFields = {
        auth_token: auth.tokens.access_token,
        oauth_tokens: auth.tokens,
      };
      if (auth.client) fields.oauth_client = auth.client;
      return fields;
    }
    case 'oauth_client_credentials':
      return { oauth_client_credentials: auth.credentials };
  }
}
