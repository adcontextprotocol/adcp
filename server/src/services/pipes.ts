import { workos } from '../auth/workos-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('pipes');

const GITHUB_PROVIDER = 'github';

export type PipesTokenResult =
  | { status: 'ok'; accessToken: string; scopes: string[]; missingScopes: string[] }
  | { status: 'not_connected' }
  | { status: 'needs_reauthorization'; missingScopes: string[] };

export async function getGitHubAccessToken(workosUserId: string): Promise<PipesTokenResult> {
  const result = await workos.pipes.getAccessToken({
    provider: GITHUB_PROVIDER,
    userId: workosUserId,
  });

  if (result.active) {
    return {
      status: 'ok',
      accessToken: result.accessToken.accessToken,
      scopes: result.accessToken.scopes,
      missingScopes: result.accessToken.missingScopes,
    };
  }

  if (result.error === 'not_installed') {
    return { status: 'not_connected' };
  }

  return { status: 'needs_reauthorization', missingScopes: [] };
}

export async function getGitHubAuthorizeUrl(workosUserId: string, returnTo: string): Promise<string> {
  const response = await workos.post<{ user_id: string; return_to: string }>(
    `/data-integrations/${GITHUB_PROVIDER}/authorize`,
    { user_id: workosUserId, return_to: returnTo },
    {},
  );
  const data = (response && typeof response === 'object' && 'data' in response ? response.data : response) as { url?: string };
  if (!data?.url) {
    logger.error({ workosUserId, response }, 'Pipes authorize response missing url');
    throw new Error('Pipes authorize response missing url');
  }
  return data.url;
}

export async function getGitHubConnectedAccount(workosUserId: string): Promise<{ login?: string } | null> {
  try {
    const response = await workos.get(
      `/user_management/users/${encodeURIComponent(workosUserId)}/connected_accounts/${GITHUB_PROVIDER}`,
      {},
    );
    const data = (response && typeof response === 'object' && 'data' in response ? response.data : response) as Record<string, unknown>;
    const handle = typeof data?.external_user_handle === 'string'
      ? data.external_user_handle
      : typeof data?.external_handle === 'string'
        ? data.external_handle
        : undefined;
    return { login: handle };
  } catch (error) {
    const status = (error as { status?: number; code?: number })?.status ?? (error as { code?: number })?.code;
    if (status === 404) return null;
    logger.warn({ err: error, workosUserId }, 'Failed to look up Pipes connected account');
    return null;
  }
}
