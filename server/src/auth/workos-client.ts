import { WorkOS } from '@workos-inc/node';
import type { WorkOSUser } from '../types.js';

if (!process.env.WORKOS_API_KEY) {
  throw new Error('WORKOS_API_KEY environment variable is required');
}

if (!process.env.WORKOS_CLIENT_ID) {
  throw new Error('WORKOS_CLIENT_ID environment variable is required');
}

export const workos = new WorkOS(process.env.WORKOS_API_KEY);
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
  accessToken: string;
  refreshToken: string;
}> {
  const redirectUri = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';

  const { user, accessToken, refreshToken } =
    await workos.userManagement.authenticateWithCode({
      clientId,
      code,
      session: {
        sealSession: true,
        cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      },
    });

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
    accessToken,
    refreshToken,
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
 * Load and verify a sealed session from cookie
 */
export async function loadSealedSession(sessionData: string): Promise<{
  authenticated: boolean;
  user?: WorkOSUser;
  accessToken?: string;
}> {
  try {
    const session = workos.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    });

    // Authenticate the session to get user data
    const authResult = await session.authenticate();

    // Check if authentication was successful
    if (!('user' in authResult) || !authResult.user) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      user: {
        id: authResult.user.id,
        email: authResult.user.email,
        firstName: authResult.user.firstName || undefined,
        lastName: authResult.user.lastName || undefined,
        emailVerified: authResult.user.emailVerified,
        createdAt: authResult.user.createdAt,
        updatedAt: authResult.user.updatedAt,
      },
      accessToken: authResult.accessToken,
    };
  } catch (error) {
    console.error('Failed to load sealed session:', error);
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
