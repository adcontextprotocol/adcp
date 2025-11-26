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
 * Middleware to require authentication
 * Checks for WorkOS session cookie and loads user info
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionCookie = req.cookies['wos-session'];

  logger.debug({ path: req.path, hasCookie: !!sessionCookie }, 'Authentication check');

  if (!sessionCookie) {
    logger.debug('No session cookie found');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      login_url: '/auth/login',
    });
  }

  try {
    // Note: clientId is configured in the WorkOS instance, not passed here
    const result = await workos.userManagement.authenticateWithSessionCookie({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

    if (!result.authenticated || !('user' in result) || !result.user) {
      logger.debug('Session validation failed');
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
 * Optional auth middleware - loads user if authenticated, but doesn't require it
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const sessionCookie = req.cookies['wos-session'];

  if (!sessionCookie) {
    return next();
  }

  try {
    // Note: clientId is configured in the WorkOS instance, not passed here
    const result = await workos.userManagement.authenticateWithSessionCookie({
      sessionData: sessionCookie,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });

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
