import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('rate-limit');

/**
 * Rate limiter for invitation endpoints
 * Limits: 10 invitations per 15 minutes per user
 */
export const invitationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit by authenticated user ID if available, otherwise by IP
    const userId = (req as any).user?.id;
    return userId || req.ip || 'unknown';
  },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for invitations');

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the invitation limit. Please try again later.',
      retryAfter: Math.ceil(15 * 60), // seconds until reset
    });
  },
});

/**
 * Rate limiter for authentication endpoints
 * Limits: 100 attempts per 15 minutes per IP
 *
 * Note: This is relatively permissive because:
 * 1. Auth redirects from failed session validation count against the limit
 * 2. Multiple users may share an IP (office, VPN, etc.)
 * 3. Browser refreshes during auth flow count as attempts
 *
 * WorkOS provides additional protection against credential stuffing.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for authentication');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many authentication attempts. Please try again later.',
      retryAfter: Math.ceil(15 * 60),
    });
  },
});

/**
 * Rate limiter for organization creation
 * Limits: 5 orgs per hour per user
 */
export const orgCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = (req as any).user?.id;
    return userId || req.ip || 'unknown';
  },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for organization creation');

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the organization creation limit. Please try again later.',
      retryAfter: Math.ceil(60 * 60),
    });
  },
});
