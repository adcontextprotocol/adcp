import type { Request, Response, NextFunction } from 'express';
import { WorkOS } from '@workos-inc/node';
import { CompanyDatabase } from '../db/company-db.js';
import type { WorkOSUser, Company, CompanyUser } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('auth-middleware');

// Initialize WorkOS client
const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID!;
const WORKOS_COOKIE_PASSWORD = process.env.WORKOS_COOKIE_PASSWORD!;

// Session validation cache to reduce WorkOS API calls
// Key: hash of session cookie, Value: { user, accessToken, expiresAt, newSealedSession? }
interface CachedSession {
  user: WorkOSUser;
  accessToken: string;
  expiresAt: number;
  newSealedSession?: string; // Set if session was refreshed
}
const sessionCache = new Map<string, CachedSession>();

// Cache TTL: 60 seconds - short enough to catch revocations, long enough to reduce API calls
const SESSION_CACHE_TTL_MS = 60 * 1000;

// Clean up expired cache entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of sessionCache.entries()) {
    if (value.expiresAt < now) {
      sessionCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned, remaining: sessionCache.size }, 'Cleaned expired session cache entries');
  }
}, 5 * 60 * 1000);

// Simple hash function for cache key (we don't need crypto-strength, just uniqueness)
function hashSessionCookie(cookie: string): string {
  let hash = 0;
  for (let i = 0; i < cookie.length; i++) {
    const char = cookie.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * Invalidate session cache for a specific cookie (e.g., on logout)
 */
export function invalidateSessionCache(sessionCookie: string): void {
  const cacheKey = hashSessionCookie(sessionCookie);
  sessionCache.delete(cacheKey);
  logger.debug({ cacheKey }, 'Session cache invalidated');
}

// Extend Express Request type to include our auth properties
declare global {
  namespace Express {
    interface Request {
      user?: WorkOSUser;
      accessToken?: string;
      company?: Company;
      companyUser?: CompanyUser;
    }
  }
}

const companyDb = new CompanyDatabase();

// Allow insecure cookies for local Docker development
const ALLOW_INSECURE_COOKIES = process.env.ALLOW_INSECURE_COOKIES === 'true';

// Dev mode: bypass auth with mock users for local testing
// Set DEV_USER_EMAIL and DEV_USER_ID in .env.local to enable
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const DEV_USER_ID = process.env.DEV_USER_ID;
const DEV_MODE_ENABLED = !!(DEV_USER_EMAIL && DEV_USER_ID);

// Multiple dev users for testing different scenarios
// Switch between users by setting ?dev_user=<key> query param or X-Dev-User header
export interface DevUserConfig {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
  isMember: boolean; // Has an organization membership
  description: string;
}

export const DEV_USERS: Record<string, DevUserConfig> = {
  // Admin dev user (separate from real admin accounts for testing)
  admin: {
    id: 'user_dev_admin_001',
    email: 'admin@test.local',
    firstName: 'Admin',
    lastName: 'Tester',
    isAdmin: true,
    isMember: true,
    description: 'Test admin with full access',
  },
  // Member user (has organization but not admin)
  member: {
    id: 'user_dev_member_001',
    email: 'member@test.local',
    firstName: 'Member',
    lastName: 'User',
    isAdmin: false,
    isMember: true,
    description: 'Regular member with organization access',
  },
  // Non-member user (no organization, just signed up)
  nonmember: {
    id: 'user_dev_nonmember_001',
    email: 'visitor@test.local',
    firstName: 'Visitor',
    lastName: 'User',
    isAdmin: false,
    isMember: false,
    description: 'User without any organization membership',
  },
};

// Dev session cookie name
const DEV_SESSION_COOKIE = 'dev-session';

if (DEV_MODE_ENABLED) {
  logger.warn({
    availableUsers: Object.keys(DEV_USERS),
  }, 'DEV MODE ENABLED - Auth bypass active. DO NOT use in production!');
  logger.info('Visit /auth/login to select a test user');
}

/**
 * Get the current dev user based on request context
 * Reads from dev-session cookie set by dev login page
 */
export function getDevUser(req?: Request): DevUserConfig | null {
  if (!req) return null;

  // Read user key from dev-session cookie
  const userKey = req.cookies?.[DEV_SESSION_COOKIE];
  if (userKey && DEV_USERS[userKey]) {
    return DEV_USERS[userKey];
  }

  // No valid dev session - user is not logged in
  return null;
}

/**
 * Get the dev session cookie name (for setting/clearing)
 */
export function getDevSessionCookieName(): string {
  return DEV_SESSION_COOKIE;
}

/**
 * Create a mock user for dev mode
 * Returns null if no dev user is logged in
 */
function createDevUser(req?: Request): WorkOSUser | null {
  const devUser = getDevUser(req);
  if (!devUser) return null;

  return {
    id: devUser.id,
    email: devUser.email,
    firstName: devUser.firstName,
    lastName: devUser.lastName,
    emailVerified: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Check if dev mode is enabled
 */
export function isDevModeEnabled(): boolean {
  return DEV_MODE_ENABLED;
}

/**
 * Get all available dev users (for UI switcher)
 */
export function getAvailableDevUsers(): Record<string, DevUserConfig> {
  return DEV_USERS;
}

/**
 * Helper to set the session cookie with consistent options
 */
function setSessionCookie(res: Response, sealedSession: string) {
  res.cookie('wos-session', sealedSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && !ALLOW_INSECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/**
 * Middleware to require authentication
 * Checks for WorkOS session cookie and loads user info
 * Uses in-memory cache to reduce WorkOS API calls for session refresh
 * Automatically refreshes expired access tokens using the refresh token
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const isHtmlRequest = req.accepts('html') && !req.path.startsWith('/api/');

  // Dev mode: check for dev-session cookie
  if (DEV_MODE_ENABLED) {
    const devUser = createDevUser(req);
    if (devUser) {
      req.user = devUser;
      req.accessToken = 'dev-mode-token';
      return next();
    }
    // No dev session - redirect to dev login page
    logger.debug('No dev session cookie found');
    if (isHtmlRequest) {
      return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      login_url: '/auth/login',
    });
  }

  const sessionCookie = req.cookies['wos-session'];

  logger.debug({ path: req.path, hasCookie: !!sessionCookie, isHtmlRequest }, 'Authentication check');

  if (!sessionCookie) {
    logger.debug('No session cookie found');
    if (isHtmlRequest) {
      return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      login_url: '/auth/login',
    });
  }

  try {
    // Check session cache first to avoid repeated WorkOS API calls
    const cacheKey = hashSessionCookie(sessionCookie);
    const cached = sessionCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      // Cache hit - use cached session data
      logger.debug({ userId: cached.user.id }, 'Using cached session');
      req.user = cached.user;
      req.accessToken = cached.accessToken;

      // If session was refreshed, update the cookie
      if (cached.newSealedSession) {
        setSessionCookie(res, cached.newSealedSession);
      }

      return next();
    }

    // Cache miss or expired - validate with WorkOS
    // Load the sealed session to get access to both authenticate and refresh methods
    const session = workos.userManagement.loadSealedSession({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

    // Try to authenticate with the current session (local JWT validation, no API call)
    let result = await session.authenticate();
    let newSealedSession: string | undefined;

    // If authentication failed, try to refresh the session (this makes an API call)
    if (!result.authenticated || !('user' in result) || !result.user) {
      logger.debug('Session authentication failed, attempting refresh');

      try {
        const refreshResult = await session.refresh({
          cookiePassword: WORKOS_COOKIE_PASSWORD,
        });

        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Refresh succeeded - update the cookie and re-authenticate
          logger.debug('Session refreshed successfully');
          newSealedSession = refreshResult.sealedSession;
          setSessionCookie(res, refreshResult.sealedSession);

          // Re-authenticate with the new session (local validation)
          const newSession = workos.userManagement.loadSealedSession({
            sessionData: refreshResult.sealedSession,
            cookiePassword: WORKOS_COOKIE_PASSWORD,
          });
          result = await newSession.authenticate();
        }
      } catch (refreshError) {
        logger.debug({ err: refreshError }, 'Session refresh failed');
        // Continue with the original failed result
      }
    }

    // Final check after potential refresh
    if (!result.authenticated || !('user' in result) || !result.user) {
      logger.debug('Session validation failed (even after refresh attempt)');
      // Remove any stale cache entry
      sessionCache.delete(cacheKey);
      if (isHtmlRequest) {
        return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Your session has expired. Please log in again.',
        login_url: '/auth/login',
      });
    }

    // Map WorkOS user to our WorkOSUser type (convert null to undefined)
    // The result may include impersonator info if session is impersonated
    const authenticatedResult = result as typeof result & {
      impersonator?: { email: string; reason: string | null };
    };

    const user: WorkOSUser = {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? undefined,
      lastName: result.user.lastName ?? undefined,
      emailVerified: result.user.emailVerified,
      createdAt: result.user.createdAt,
      updatedAt: result.user.updatedAt,
      impersonator: authenticatedResult.impersonator,
    };

    // Log impersonation for audit
    if (user.impersonator) {
      logger.info(
        { userId: user.id, impersonatorEmail: user.impersonator.email, reason: user.impersonator.reason },
        'Impersonation session detected'
      );
    }

    // Cache the validated session
    sessionCache.set(cacheKey, {
      user,
      accessToken: result.accessToken,
      expiresAt: now + SESSION_CACHE_TTL_MS,
      newSealedSession,
    });

    req.user = user;
    req.accessToken = result.accessToken;
    next();
  } catch (error) {
    logger.error({ err: error }, 'Authentication middleware error');
    if (isHtmlRequest) {
      return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Unable to verify your session. Please log in again.',
      login_url: '/auth/login',
    });
  }
}

/**
 * Middleware to require access to a specific company
 * Checks that the authenticated user is a member of the company
 */
export async function requireCompanyAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
    });
  }

  const companyId = req.params.companyId || req.body.company_id;

  if (!companyId) {
    return res.status(400).json({
      error: 'Company ID required',
      message: 'Please specify a company ID',
    });
  }

  try {
    // Check if user has access to this company
    const companyUser = await companyDb.getCompanyUser(companyId, req.user.id);

    if (!companyUser) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You do not have access to this company',
      });
    }

    // Load full company info
    const company = await companyDb.getCompany(companyId);

    if (!company) {
      return res.status(404).json({
        error: 'Company not found',
        message: 'The specified company does not exist',
      });
    }

    req.company = company;
    req.companyUser = companyUser;
    next();
  } catch (error) {
    logger.error({ err: error }, 'Company access middleware error');
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Unable to verify company access',
    });
  }
}

/**
 * Middleware to require an active subscription
 * Must be used after requireCompanyAccess
 */
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  if (!req.company) {
    return res.status(400).json({
      error: 'Company context required',
      message: 'This endpoint requires company context',
    });
  }

  const company = req.company;

  // Check if company has a subscription
  if (!company.stripe_subscription_id) {
    return res.status(402).json({
      error: 'No active subscription',
      message: 'Please subscribe to manage registry entries',
      pricing_url: '/pricing',
    });
  }

  // Check subscription status
  if (company.subscription_status !== 'active' && company.subscription_status !== 'trialing') {
    return res.status(402).json({
      error: 'Subscription inactive',
      message: `Subscription status: ${company.subscription_status}. Please update your billing.`,
      subscription_status: company.subscription_status,
      manage_url: '/api/billing/portal',
    });
  }

  next();
}

/**
 * Middleware to require signed agreement
 * Must be used after requireCompanyAccess
 */
export async function requireSignedAgreement(req: Request, res: Response, next: NextFunction) {
  if (!req.company) {
    return res.status(400).json({
      error: 'Company context required',
      message: 'This endpoint requires company context',
    });
  }

  const company = req.company;

  if (!company.agreement_signed_at) {
    return res.status(403).json({
      error: 'Agreement not signed',
      message: 'Please review and sign the AdCP Terms of Service before continuing',
      agreement_url: '/api/agreement/current',
    });
  }

  next();
}

/**
 * Middleware to require specific role(s) within a company
 * Must be used after requireCompanyAccess
 */
export function requireRole(...allowedRoles: Array<'owner' | 'admin' | 'member'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.companyUser) {
      return res.status(400).json({
        error: 'Company user context required',
        message: 'This endpoint requires company user context',
      });
    }

    if (!allowedRoles.includes(req.companyUser.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`,
        your_role: req.companyUser.role,
      });
    }

    next();
  };
}

/**
 * Middleware to require admin access
 * Must be used after requireAuth
 * Checks if user's email is from @agenticadvertising.org domain
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const isHtmlRequest = req.accepts('html') && !req.path.startsWith('/api/');

  // Dev mode: check if dev user has admin flag
  if (DEV_MODE_ENABLED) {
    const devUser = getDevUser(req);
    if (!devUser) {
      // Not logged in
      if (isHtmlRequest) {
        return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource',
        login_url: '/auth/login',
      });
    }

    // Set user on request if not already set
    if (!req.user) {
      const mockUser = createDevUser(req);
      if (mockUser) {
        req.user = mockUser;
        req.accessToken = 'dev-mode-token';
      }
    }

    // Check dev user's isAdmin flag
    if (!devUser.isAdmin) {
      logger.warn({ userId: devUser.id, email: devUser.email }, 'Non-admin dev user attempted to access admin endpoint');
      if (isHtmlRequest) {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Access Denied</title>
            <link rel="stylesheet" href="/design-system.css">
            <style>
              body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: var(--color-bg-page, #f5f5f5); }
              .container { background: var(--color-bg-card, white); padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
              h1 { color: var(--color-error-600, #c33); margin-bottom: 10px; }
              p { color: var(--color-text-secondary, #666); margin-bottom: 20px; }
              a { color: var(--color-brand, #667eea); text-decoration: none; }
              a:hover { text-decoration: underline; }
              .dev-hint { margin-top: 20px; padding: 15px; background: var(--color-bg-subtle, #f9fafb); border-radius: 6px; font-size: 13px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Access Denied</h1>
              <p>This resource is only accessible to administrators.</p>
              <p>Current user: <strong>${devUser.email}</strong></p>
              <div class="dev-hint">
                <strong>Dev Mode Tip:</strong><br>
                <a href="/auth/logout">Log out</a> and log in as admin
              </div>
              <p><a href="/">← Back to Home</a></p>
            </div>
          </body>
          </html>
        `);
      }
      return res.status(403).json({
        error: 'Admin access required',
        message: 'This resource is only accessible to administrators',
        current_user: devUser.email,
      });
    }
    return next();
  }

  if (!req.user) {
    if (isHtmlRequest) {
      return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
    });
  }

  // Check admin access via environment variable (comma-separated list of emails)
  const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
  const isAdmin = adminEmails.includes(req.user.email.toLowerCase());

  if (!isAdmin) {
    logger.warn({ userId: req.user.id, email: req.user.email }, 'Non-admin user attempted to access admin endpoint');
    if (isHtmlRequest) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Access Denied</title>
          <style>
            body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
            .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
            h1 { color: #c33; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 20px; }
            a { color: #667eea; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Access Denied</h1>
            <p>This resource is only accessible to administrators.</p>
            <a href="/">← Back to Home</a>
          </div>
        </body>
        </html>
      `);
    }
    return res.status(403).json({
      error: 'Admin access required',
      message: 'This resource is only accessible to administrators',
    });
  }

  logger.debug({ userId: req.user.id, email: req.user.email }, 'Admin access granted');
  next();
}

/**
 * Factory function to create middleware that requires working group leader access
 * Must be used after requireAuth
 * Checks if user is a leader of the specified working group OR a site admin
 *
 * @param workingGroupDb - Database instance for looking up working group details
 */
export function createRequireWorkingGroupLeader(
  workingGroupDb: {
    getWorkingGroupBySlug: (slug: string) => Promise<{ id: string; leaders?: Array<{ user_id: string }> } | null>;
    isLeader: (workingGroupId: string, userId: string) => Promise<boolean>;
  }
) {
  return async function requireWorkingGroupLeader(req: Request, res: Response, next: NextFunction) {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource',
      });
    }

    const slug = req.params.slug;
    if (!slug) {
      return res.status(400).json({
        error: 'Missing working group slug',
        message: 'Working group slug is required',
      });
    }

    // Check if user is a site admin first (admins can manage all groups)
    const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
    const isAdmin = adminEmails.includes(req.user.email.toLowerCase());

    if (isAdmin) {
      logger.debug({ userId: req.user.id, slug }, 'Admin access granted to working group');
      return next();
    }

    // Look up the working group
    const workingGroup = await workingGroupDb.getWorkingGroupBySlug(slug);
    if (!workingGroup) {
      return res.status(404).json({
        error: 'Working group not found',
        message: `No working group found with slug '${slug}'`,
      });
    }

    // Check if user is a leader
    const isLeader = await workingGroupDb.isLeader(workingGroup.id, req.user.id);

    if (!isLeader) {
      logger.warn({ userId: req.user.id, slug }, 'Non-leader user attempted to access working group admin endpoint');
      return res.status(403).json({
        error: 'Working group leader access required',
        message: 'This resource is only accessible to leaders of this working group',
      });
    }

    // Attach working group to request for use in route handlers
    (req as Request & { workingGroup: typeof workingGroup }).workingGroup = workingGroup;

    logger.debug({ userId: req.user.id, slug }, 'Working group leader access granted');
    next();
  };
}

/**
 * Optional auth middleware - loads user if authenticated, but doesn't require it
 * Uses in-memory cache to reduce WorkOS API calls for session refresh
 * Automatically refreshes expired access tokens using the refresh token
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  // Dev mode: set dev user if logged in via dev-session cookie
  if (DEV_MODE_ENABLED) {
    const devUser = createDevUser(req);
    if (devUser) {
      req.user = devUser;
      req.accessToken = 'dev-mode-token';
    }
    // No dev session = not logged in (which is fine for optional auth)
    return next();
  }

  const sessionCookie = req.cookies['wos-session'];

  if (!sessionCookie) {
    return next();
  }

  try {
    // Check session cache first to avoid repeated WorkOS API calls
    const cacheKey = hashSessionCookie(sessionCookie);
    const cached = sessionCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      // Cache hit - use cached session data
      logger.debug({ userId: cached.user.id }, 'Using cached session (optional auth)');
      req.user = cached.user;
      req.accessToken = cached.accessToken;

      // If session was refreshed, update the cookie
      if (cached.newSealedSession) {
        setSessionCookie(res, cached.newSealedSession);
      }

      return next();
    }

    // Cache miss or expired - validate with WorkOS
    // Load the sealed session to get access to both authenticate and refresh methods
    const session = workos.userManagement.loadSealedSession({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

    // Try to authenticate with the current session (local JWT validation)
    let result = await session.authenticate();
    let newSealedSession: string | undefined;

    // If authentication failed, try to refresh the session (API call)
    if (!result.authenticated || !('user' in result) || !result.user) {
      try {
        const refreshResult = await session.refresh({
          cookiePassword: WORKOS_COOKIE_PASSWORD,
        });

        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Refresh succeeded - update the cookie and re-authenticate
          logger.debug('Session refreshed successfully (optional auth)');
          newSealedSession = refreshResult.sealedSession;
          setSessionCookie(res, refreshResult.sealedSession);

          // Re-authenticate with the new session (local validation)
          const newSession = workos.userManagement.loadSealedSession({
            sessionData: refreshResult.sealedSession,
            cookiePassword: WORKOS_COOKIE_PASSWORD,
          });
          result = await newSession.authenticate();
        }
      } catch (refreshError) {
        // Silently fail refresh for optional auth
        logger.debug({ err: refreshError }, 'Optional auth refresh failed');
      }
    }

    if (result.authenticated && 'user' in result && result.user) {
      // The result may include impersonator info if session is impersonated
      const authenticatedResult = result as typeof result & {
        impersonator?: { email: string; reason: string | null };
      };

      const user: WorkOSUser = {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName ?? undefined,
        lastName: result.user.lastName ?? undefined,
        emailVerified: result.user.emailVerified,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt,
        impersonator: authenticatedResult.impersonator,
      };

      // Log impersonation for audit
      if (user.impersonator) {
        logger.info(
          { userId: user.id, impersonatorEmail: user.impersonator.email, reason: user.impersonator.reason },
          'Impersonation session detected (optional auth)'
        );
      }

      // Cache the validated session
      sessionCache.set(cacheKey, {
        user,
        accessToken: result.accessToken,
        expiresAt: now + SESSION_CACHE_TTL_MS,
        newSealedSession,
      });

      req.user = user;
      req.accessToken = result.accessToken;
    }
  } catch (error) {
    // Silently fail for optional auth
    logger.debug({ err: error }, 'Optional auth failed');
  }

  next();
}
