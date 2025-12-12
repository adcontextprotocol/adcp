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

/**
 * Helper to set the session cookie with consistent options
 */
function setSessionCookie(res: Response, sealedSession: string) {
  res.cookie('wos-session', sealedSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/**
 * Middleware to require authentication
 * Checks for WorkOS session cookie and loads user info
 * Automatically refreshes expired access tokens using the refresh token
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionCookie = req.cookies['wos-session'];
  const isHtmlRequest = req.accepts('html') && !req.path.startsWith('/api/');

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
    // Load the sealed session to get access to both authenticate and refresh methods
    const session = workos.userManagement.loadSealedSession({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

    // Try to authenticate with the current session
    let result = await session.authenticate();

    // If authentication failed, try to refresh the session
    if (!result.authenticated || !('user' in result) || !result.user) {
      logger.debug('Session authentication failed, attempting refresh');

      try {
        const refreshResult = await session.refresh({
          cookiePassword: WORKOS_COOKIE_PASSWORD,
        });

        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Refresh succeeded - update the cookie and re-authenticate
          logger.debug('Session refreshed successfully');
          setSessionCookie(res, refreshResult.sealedSession);

          // Re-authenticate with the new session
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
    req.user = {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? undefined,
      lastName: result.user.lastName ?? undefined,
      emailVerified: result.user.emailVerified,
      createdAt: result.user.createdAt,
      updatedAt: result.user.updatedAt,
    };
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
            <a href="/dashboard">← Back to Dashboard</a>
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
 * Optional auth middleware - loads user if authenticated, but doesn't require it
 * Automatically refreshes expired access tokens using the refresh token
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const sessionCookie = req.cookies['wos-session'];

  if (!sessionCookie) {
    return next();
  }

  try {
    // Load the sealed session to get access to both authenticate and refresh methods
    const session = workos.userManagement.loadSealedSession({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

    // Try to authenticate with the current session
    let result = await session.authenticate();

    // If authentication failed, try to refresh the session
    if (!result.authenticated || !('user' in result) || !result.user) {
      try {
        const refreshResult = await session.refresh({
          cookiePassword: WORKOS_COOKIE_PASSWORD,
        });

        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Refresh succeeded - update the cookie and re-authenticate
          logger.debug('Session refreshed successfully (optional auth)');
          setSessionCookie(res, refreshResult.sealedSession);

          // Re-authenticate with the new session
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
      req.user = {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName ?? undefined,
        lastName: result.user.lastName ?? undefined,
        emailVerified: result.user.emailVerified,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt,
      };
      req.accessToken = result.accessToken;
    }
  } catch (error) {
    // Silently fail for optional auth
    logger.debug({ err: error }, 'Optional auth failed');
  }

  next();
}
