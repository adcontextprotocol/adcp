import { WorkOS } from '@workos-inc/node';
import type { WorkOSUser } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('workos-client');

let _workos: WorkOS | null = null;
let _clientId = '';

/** Returns the shared WorkOS client. Constructed on first call; WORKOS_API_KEY and WORKOS_CLIENT_ID must be set by then. */
export function getWorkos(): WorkOS {
  if (!_workos) {
    if (!process.env.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY environment variable is required');
    if (!process.env.WORKOS_CLIENT_ID) throw new Error('WORKOS_CLIENT_ID environment variable is required');
    _clientId = process.env.WORKOS_CLIENT_ID;
    _workos = new WorkOS(process.env.WORKOS_API_KEY, { clientId: _clientId });
  }
  return _workos;
}

/**
 * Get the authorization URL to redirect users to WorkOS for authentication
 */
export function getAuthorizationUrl(state?: string): string {
  const workos = getWorkos();
  const redirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';

  return workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId: _clientId,
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
  const workos = getWorkos();
  const redirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';

  logger.debug('Authenticating with authorization code');

  const { user, sealedSession } =
    await workos.userManagement.authenticateWithCode({
      clientId: _clientId,
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
  const workos = getWorkos();
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

    const workos = getWorkos();

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
  const workos = getWorkos();
  const response = await workos.userManagement.authenticateWithRefreshToken({
    clientId: _clientId,
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
  user: WorkOSUser;
}> {
  const workos = getWorkos();
  logger.debug('Authenticating with code for tokens (MCP flow)');

  const result = await workos.userManagement.authenticateWithCode({
    clientId: _clientId,
    code,
  });

  logger.info({ userId: result.user.id }, 'MCP: User authenticated for tokens');

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? undefined,
      lastName: result.user.lastName ?? undefined,
      emailVerified: result.user.emailVerified,
      createdAt: result.user.createdAt,
      updatedAt: result.user.updatedAt,
    },
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
  const workos = getWorkos();
  const response = await workos.userManagement.authenticateWithRefreshToken({
    clientId: _clientId,
    refreshToken: refreshTokenValue,
  });

  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
  };
}

/**
 * Find or create a WorkOS user by email. Used by the newsletter confirm flow
 * to provision lightweight accounts once the user has proven control of their
 * email. New users are created with emailVerified: false — verification
 * happens only via explicit OAuth login.
 */
export async function findOrCreateUserByEmail(email: string): Promise<WorkOSUser> {
  const workos = getWorkos();
  const normalized = email.trim().toLowerCase();

  const toUser = (u: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
  }): WorkOSUser => ({
    id: u.id,
    email: u.email,
    firstName: u.firstName || undefined,
    lastName: u.lastName || undefined,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  });

  const lookup = async () => {
    const existing = await workos.userManagement.listUsers({ email: normalized });
    return existing.data.find((u) => u.email.toLowerCase() === normalized);
  };

  const existing = await lookup();
  if (existing) return toUser(existing);

  try {
    const created = await workos.userManagement.createUser({
      email: normalized,
      emailVerified: false,
    });
    logger.info({ userId: created.id }, 'Created WorkOS user for newsletter subscribe');
    return toUser(created);
  } catch (error) {
    // Concurrent request may have created the user between our lookup and
    // create. Re-fetch before surfacing the error.
    const retry = await lookup();
    if (retry) {
      logger.info({ userId: retry.id }, 'WorkOS createUser raced; returning existing user');
      return toUser(retry);
    }
    throw error;
  }
}
