import { WorkOS } from '@workos-inc/node';
import type { WorkOSUser } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('workos-client');

if (!process.env.WORKOS_API_KEY) {
  throw new Error('WORKOS_API_KEY environment variable is required');
}

if (!process.env.WORKOS_CLIENT_ID) {
  throw new Error('WORKOS_CLIENT_ID environment variable is required');
}

export const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});
export const clientId = process.env.WORKOS_CLIENT_ID!;

/**
 * Get the authorization URL to redirect users to WorkOS for authentication
 */
export function getAuthorizationUrl(state?: string): string {
  const redirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';

  return workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId,
    redirectUri,
    state,
  });
}

/**
 * Exchange authorization code for access token and user info
 */
export async function authenticateWithCode(code: string): Promise<{
  user: WorkOSUser;
  sealedSession: string;
}> {
  const redirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';

  logger.debug('Authenticating with authorization code');

  const { user, sealedSession } =
    await workos.userManagement.authenticateWithCode({
      clientId,
      code,
      session: {
        sealSession: true,
        cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      },
    });

  logger.info({ userId: user.id }, 'User authenticated successfully');

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName || undefined,
      lastName: user.lastName || undefined,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    sealedSession: sealedSession!,
  };
}

/**
 * Get user info from access token
 */
export async function getUser(accessToken: string): Promise<WorkOSUser> {
  const user = await workos.userManagement.getUser(accessToken);

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName || undefined,
    lastName: user.lastName || undefined,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Load and verify sealed session from cookie using WorkOS
 */
export async function loadSealedSession(sessionData: string): Promise<{
  authenticated: boolean;
  user?: WorkOSUser;
  accessToken?: string;
}> {
  try {
    logger.debug('Validating sealed session');

    // Use WorkOS's authenticateWithSessionCookie to validate and unseal
    // Note: clientId is configured in the WorkOS instance, not passed here
    const result = await workos.userManagement.authenticateWithSessionCookie({
      sessionData,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    });

    if (!result.authenticated || !result.user) {
      logger.debug({ reason: (result as any).reason }, 'Session validation failed');
      return { authenticated: false };
    }

    logger.debug({ userId: result.user.id }, 'Session validated successfully');

    return {
      authenticated: true,
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName || undefined,
        lastName: result.user.lastName || undefined,
        emailVerified: result.user.emailVerified,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt,
      },
      accessToken: result.accessToken,
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to validate session');
    return { authenticated: false };
  }
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const response = await workos.userManagement.authenticateWithRefreshToken({
    clientId,
    refreshToken,
    session: {
      sealSession: true,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    },
  });

  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
  };
}

/**
 * Exchange authorization code for tokens without sealed session.
 * Used by MCP OAuth flow where we need raw tokens, not cookies.
 */
export async function authenticateWithCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  logger.debug('Authenticating with code for tokens (MCP flow)');

  const result = await workos.userManagement.authenticateWithCode({
    clientId,
    code,
  });

  logger.info({ userId: result.user.id }, 'MCP: User authenticated for tokens');

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  };
}

/**
 * Refresh tokens without sealed session.
 * Used by MCP OAuth flow.
 */
export async function refreshTokenRaw(refreshTokenValue: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const response = await workos.userManagement.authenticateWithRefreshToken({
    clientId,
    refreshToken: refreshTokenValue,
  });

  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
  };
}
