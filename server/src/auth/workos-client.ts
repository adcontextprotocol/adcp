import { WorkOS } from '@workos-inc/node';
import type { WorkOSUser } from '../types.js';

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

  console.log('[WORKOS] Authenticating with code...');

  const { user, sealedSession } =
    await workos.userManagement.authenticateWithCode({
      clientId,
      code,
      session: {
        sealSession: true,
        cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      },
    });

  console.log('[WORKOS] Authentication successful');
  console.log('[WORKOS] Sealed session length:', sealedSession?.length);
  console.log('[WORKOS] User:', user.email);

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
    console.log('[WORKOS] Validating sealed session, length:', sessionData.length);
    console.log('[WORKOS] Using clientId:', clientId);

    // Use WorkOS's authenticateWithSessionCookie to validate and unseal
    // Note: clientId is configured in the WorkOS instance, not passed here
    const result = await workos.userManagement.authenticateWithSessionCookie({
      sessionData,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    });

    console.log('[WORKOS] *** authenticateWithSessionCookie called successfully ***');

    console.log('[WORKOS] Auth result authenticated:', result.authenticated);

    if (!result.authenticated || !result.user) {
      console.log('[WORKOS] Session validation failed, reason:', (result as any).reason);
      return { authenticated: false };
    }

    console.log('[WORKOS] Session valid for user:', result.user.email);

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
    console.error('[WORKOS] Failed to validate session:', error);
    console.error('[WORKOS] Error details:', error instanceof Error ? error.message : String(error));
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
