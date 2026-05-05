import { createLogger } from '../logger.js';
import { getWorkos } from '../auth/workos-client.js';

const logger = createLogger('pipes');

const GITHUB_PROVIDER = 'github';

export type PipesTokenResult =
  | { status: 'ok'; accessToken: string; scopes: string[]; missingScopes: string[] }
  | { status: 'not_connected' }
  | { status: 'needs_reauthorization'; missingScopes: string[] };

export async function getGitHubAccessToken(workosUserId: string): Promise<PipesTokenResult> {
  const workos = getWorkos();
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

/**
 * Builds the absolute return URL we hand to WorkOS Pipes when the user finishes
 * the OAuth dance. Validates the caller-supplied path so a Slack-clicked link
 * (or any user-controlled `return_to`) cannot be rewritten into an open
 * redirect to another origin. Shared by both the Member Hub `POST authorize`
 * route and the `GET /connect/github` bouncer that Addie hands out.
 */
export function buildPipesReturnTo(
  host: string,
  protocol: string,
  requested: unknown,
  defaultPath = '/member-hub?connected=github',
): string {
  const candidate = typeof requested === 'string' ? requested : defaultPath;
  const isSafe = candidate.startsWith('/')
    && !candidate.startsWith('//')
    && !candidate.includes('\\')
    && !/[\r\n\t]/.test(candidate);
  const safe = isSafe ? candidate : defaultPath;
  const safeProtocol = protocol === 'http' && !host.startsWith('localhost') ? 'https' : protocol;
  return `${safeProtocol}://${host}${safe}`;
}

export async function getGitHubAuthorizeUrl(workosUserId: string, returnTo: string): Promise<string> {
  const workos = getWorkos();
  let returnToHost = '';
  try {
    returnToHost = new URL(returnTo).host;
  } catch {
    // returnTo is unparseable; leave host empty so the log captures that fact
  }
  try {
    const response = await workos.post<{ user_id: string; return_to: string }>(
      `/data-integrations/${GITHUB_PROVIDER}/authorize`,
      { user_id: workosUserId, return_to: returnTo },
      {},
    );
    const data = (response && typeof response === 'object' && 'data' in response ? response.data : response) as { url?: string };
    if (!data?.url) {
      logger.error({ workosUserId, returnToHost, response }, 'Pipes authorize response missing url');
      throw new Error('Pipes authorize response missing url');
    }
    return data.url;
  } catch (error) {
    const e = error as {
      status?: number;
      requestID?: string;
      error?: string;
      errorDescription?: string;
      rawData?: unknown;
    };
    logger.error(
      {
        err: error,
        workosUserId,
        returnToHost,
        provider: GITHUB_PROVIDER,
        workosStatus: e?.status,
        workosRequestId: e?.requestID,
        workosError: e?.error,
        workosErrorDescription: e?.errorDescription,
        workosRawData: e?.rawData,
      },
      'Pipes authorize request failed',
    );
    throw error;
  }
}

export type ConnectedAccountResult =
  | { status: 'connected'; login: string | undefined }
  | { status: 'not_connected' }
  | { status: 'unavailable'; reason: string };

export async function getGitHubConnectedAccount(workosUserId: string): Promise<ConnectedAccountResult> {
  const workos = getWorkos();
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
    return { status: 'connected', login: handle };
  } catch (error) {
    const status = (error as { status?: number; code?: number })?.status ?? (error as { code?: number })?.code;
    if (status === 404) return { status: 'not_connected' };
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, workosUserId }, 'Failed to look up Pipes connected account');
    return { status: 'unavailable', reason: message };
  }
}

export type DisconnectResult =
  | { status: 'disconnected' }
  | { status: 'not_connected' }
  | { status: 'unavailable'; reason: string };

export async function disconnectGitHub(workosUserId: string): Promise<DisconnectResult> {
  const workos = getWorkos();
  try {
    await workos.delete(
      `/user_management/users/${encodeURIComponent(workosUserId)}/connected_accounts/${GITHUB_PROVIDER}`,
    );
    return { status: 'disconnected' };
  } catch (error) {
    const status = (error as { status?: number; code?: number })?.status ?? (error as { code?: number })?.code;
    if (status === 404) return { status: 'not_connected' };
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, workosUserId }, 'Failed to disconnect Pipes GitHub account');
    return { status: 'unavailable', reason: message };
  }
}
