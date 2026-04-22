/**
 * Narrow `ResolvedOwnerAuth` (server's internal auth union) down to the
 * shape `@adcp/client`'s `ComplyOptions.auth` / `TestOptions.auth`
 * accepts (bearer | basic | oauth).
 *
 * The server supports an `oauth_client_credentials` variant (#2800)
 * that the SDK doesn't. For that variant we perform the RFC 6749 §4.4
 * exchange here and hand the SDK the resulting bearer token. All
 * other variants pass through unchanged. Failed exchanges yield
 * `undefined` so the compliance / test path proceeds unauthenticated
 * with a warning log — the alternative is dropping the entire check.
 *
 * Remove this bridge when @adcp/client learns native
 * client_credentials with 401-triggered refresh.
 */

import type { ResolvedOwnerAuth } from '../db/compliance-db.js';
import { exchangeClientCredentials } from './oauth-client-credentials-exchange.js';
import { createLogger } from '../logger.js';

const logger = createLogger('sdk-auth-adapter');

/**
 * The subset of `ResolvedOwnerAuth` the SDK accepts. Kept as a
 * structural type so we aren't importing @adcp/client's internal types
 * across the boundary.
 */
export type SdkAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | {
      type: 'oauth';
      tokens: { access_token: string; refresh_token: string; expires_at?: string };
      client?: { client_id: string; client_secret?: string };
    };

/**
 * Narrow server-resolved auth into the SDK's accepted shape. Exchanges
 * client-credentials configs on the spot. Returns `undefined` for
 * missing auth OR for exchange failures (caller proceeds unauthed).
 */
export async function adaptAuthForSdk(
  auth: ResolvedOwnerAuth | undefined,
  context: { tokenEndpointLabel?: string } = {},
): Promise<SdkAuth | undefined> {
  if (!auth) return undefined;

  switch (auth.type) {
    case 'bearer':
    case 'basic':
    case 'oauth':
      return auth;
    case 'oauth_client_credentials': {
      const result = await exchangeClientCredentials(auth.credentials);
      if (!result.ok) {
        logger.warn(
          {
            tokenEndpoint: auth.credentials.token_endpoint,
            context: context.tokenEndpointLabel,
            reason: result.error,
          },
          'OAuth client-credentials exchange failed — falling back to unauthenticated request',
        );
        return undefined;
      }
      return { type: 'bearer', token: result.access_token };
    }
  }
}
