import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createLogger } from '../logger.js';
import { CachedPostgresStore } from './pg-rate-limit-store.js';

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
  store: new CachedPostgresStore('invite:'),
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
 * Limits: 15 failed attempts per hour per user
 * Successful requests (2xx) don't count against the limit so that
 * legitimate registrations aren't penalized by earlier validation errors.
 */
export const orgCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('org:'),
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
      message: 'Too many registration attempts. Please wait an hour and try again, or email hello@agenticadvertising.org for help.',
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
  store: new CachedPostgresStore('brand:'),
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
 * Rate limiter for notification endpoints (polled from nav bell)
 * Limits: 120 requests per minute per user (allows 30s polling across multiple tabs)
 *
 * Uses CachedPostgresStore: increments are served from memory (no DB hit per
 * request) and flushed to Postgres every 15s so counters stay synced across
 * pods. This replaced a direct PostgresStore that was saturating the
 * connection pool on every poll request.
 */
export const notificationRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('notif:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for notifications');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Notification request limit exceeded. Please try again later.',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter for storyboard evaluation endpoints.
 * Limits: 5 evaluations per hour per user (each eval makes real HTTP calls to external agents).
 */
export const storyboardEvalRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('storyboard:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for storyboard evaluation');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Storyboard evaluation limit exceeded (5 per hour). Please try again later.',
      retryAfter: Math.ceil(60 * 60),
    });
  },
});

/**
 * Rate limiter for step-by-step storyboard execution.
 * More generous than full evaluation (30/hour vs 5/hour) since each step is one MCP call.
 */
export const storyboardStepRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('storyboard-step:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for storyboard step execution');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Step execution limit exceeded (30 per hour). Please try again later.',
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
  store: new CachedPostgresStore('resolve:'),
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

export const emailPrefsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('emailprefs:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for email preferences');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later.',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter for the public newsletter subscribe endpoint.
 * Unauthenticated, so keyed strictly by IP (with IPv6 /64 masking).
 * Tighter than emailPrefsRateLimiter because each accepted request sends an
 * email via Resend and may provision a WorkOS user.
 */
export const newsletterSubscribeRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('newsub:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for newsletter subscribe');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again in a minute.',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter for the public newsletter confirm GET endpoint.
 * Guards the DB lookup against high-volume token guessing/scraping. Tokens
 * are 256 bits so guessing is infeasible, but we still cap DB traffic.
 */
export const newsletterConfirmRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('newsconfirm:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for newsletter confirm');

    res.redirect('/welcome-subscribed.html?error=expired');
  },
});

/**
 * Rate limiter for admin content write operations (delete, status change)
 * Limits: 30 writes per 15 minutes per user
 */
export const adminContentWriteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('admin-content:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for admin content writes');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Admin content write rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil(15 * 60),
    });
  },
});

/**
 * Rate limiter for logo uploads
 * Limits: 10 uploads per hour per user
 */
export const logoUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('logo:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for logo uploads');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Logo upload rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil(60 * 60),
    });
  },
});
