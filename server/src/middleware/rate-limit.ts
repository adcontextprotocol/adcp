import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createLogger } from '../logger.js';

const logger = createLogger('rate-limit');

/**
 * Generate a rate limit key from request, preferring user ID over IP.
 * Uses proper IPv6 subnet masking when falling back to IP addresses.
 */
function generateKey(req: Request): string {
  const userId = (req as any).user?.id;
  if (userId) {
    return userId;
  }

  const ip = req.ip || 'unknown';

  // For IPv6 addresses, mask to /64 subnet to prevent bypass attacks
  // IPv6 users can easily rotate through addresses in their allocation
  if (ip.includes(':')) {
    // Extract first 4 segments (64 bits) of IPv6 address
    const segments = ip.split(':').slice(0, 4);
    return segments.join(':') + '::/64';
  }

  return ip;
}

/**
 * Rate limiter for invitation endpoints
 * Limits: 10 invitations per 15 minutes per user
 */
export const invitationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
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
 * Rate limiter for organization creation
 * Limits: 5 orgs per hour per user
 */
export const orgCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
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

/**
 * Rate limiter for brand creation (community submissions)
 * Limits: 60 submissions per hour per user/IP
 */
export const brandCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for brand creation');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Brand submission rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil(60 * 60),
    });
  },
});

/**
 * Rate limiter for bulk resolve endpoints
 * Limits: 20 requests per minute per IP (each request resolves up to 100 domains)
 */
export const bulkResolveRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for bulk resolve');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Bulk resolve rate limit exceeded. Please try again later.',
      retryAfter: 60,
    });
  },
});
