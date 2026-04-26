import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createLogger } from '../logger.js';
import { CachedPostgresStore } from './pg-rate-limit-store.js';
import { isWebUserAAOAdmin } from '../addie/mcp/admin-tools.js';

const logger = createLogger('rate-limit');

/**
 * Parse a `Retry-After` header value into delta-seconds. Handles both
 * the number form (express-rate-limit with `standardHeaders: true`
 * emits seconds as a number) and the string form. Returns `undefined`
 * for anything that doesn't look like a positive integer — including
 * zero, which we treat as "no meaningful wait" rather than exposing
 * a degenerate countdown value.
 *
 * Callers surface the value in the 429 body as a proxy-stripped
 * fallback for the header (#2804).
 */
export function parseRetryAfterSeconds(raw: number | string | string[] | undefined): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

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
 * Skip rate limiting for AAO platform admins. Falls back to the ADMIN_EMAILS
 * env var for emergency access, matching requireAdmin semantics.
 */
async function skipForAdmins(req: Request): Promise<boolean> {
  const user = (req as any).user as { id?: string; email?: string; isAdmin?: boolean } | undefined;
  if (!user) return false;

  if (user.isAdmin === true) return true;

  const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) ?? [];
  if (user.email && adminEmails.includes(user.email.toLowerCase())) {
    return true;
  }

  if (!user.id) return false;

  try {
    return await isWebUserAAOAdmin(user.id);
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'admin check failed in rate limiter; applying limit');
    return false;
  }
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
 * AAO platform admins bypass this limit so they can debug and curate without hitting it.
 */
export const storyboardEvalRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  skipFailedRequests: true,
  skip: skipForAdmins,
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
  skip: skipForAdmins,
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
 * Rate limiter for per-agent dashboard reads (compliance state + history).
 * The Agents dashboard fans out these two reads per saved agent on load,
 * so a member with 10+ agents hits the bulk-resolve cap immediately —
 * those requests aren't bulk, they're idempotent per-item reads.
 * Separate limiter with a ceiling high enough for normal dashboard use
 * (60-agent load × 2 endpoints = 120 req) while still bounding a script
 * that tries to enumerate compliance state for every registered agent.
 * (The sibling auth-status endpoint runs under complianceWriteMiddleware
 * and isn't gated by this limiter.)
 */
export const agentReadRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 240, // 4/sec sustained; a 60-agent × 2-endpoint burst (120 req) fits with headroom
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('agent-read:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for agent dashboard reads');

    // standardHeaders emits `Retry-After` / `RateLimit-Reset` with the
    // real remaining window — that's the authoritative signal. We also
    // surface the same value in the JSON body as a proxy-stripped
    // fallback (#2804): some reverse proxies drop non-standard
    // headers, and the dashboard needs SOMETHING to key its countdown
    // off. `retryAfter` is seconds-to-retry, matching the header's
    // delta-seconds format.
    //
    // The HTTP spec (RFC 9110 §10.2.3) also allows an HTTP-date here,
    // but express-rate-limit only emits delta-seconds — so a parseInt
    // is sufficient. If that ever changes (e.g., we swap limiter
    // libraries), the fallback below would need a second parse path.
    const retryAfter = parseRetryAfterSeconds(res.getHeader('Retry-After'));
    res.status(429).json({
      error: 'Too many requests',
      message: 'Agent dashboard read rate limit exceeded. Please try again in a moment.',
      ...(retryAfter !== undefined ? { retryAfter } : {}),
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
 * Rate limiter for content submission endpoint (POST /api/content/propose).
 * Limits: 20 submissions per 10 minutes per user.
 *
 * Protects the editorial queue from accidental floods (member accidentally
 * double-clicks submit) and abuse (scripted member spamming the review
 * channel). 20 submissions in 10 minutes is well above any legitimate
 * editorial cadence — Mary-like one-off drafts aren't affected.
 *
 * Also bounds the downstream Slack notifications and auto-cover-image
 * Gemini calls fired per submission.
 */
export const contentProposeRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new CachedPostgresStore('content-propose:'),
  keyGenerator: generateKey,
  validate: { keyGeneratorIpFallback: false },
  handler: (req: Request, res: Response) => {
    logger.warn({
      userId: (req as any).user?.id,
      ip: req.ip,
      path: req.path,
    }, 'Rate limit exceeded for content submission');

    res.status(429).json({
      error: 'Too many requests',
      message: 'Content submission rate limit exceeded (20 per 10 minutes). Please try again later.',
      retryAfter: Math.ceil(10 * 60),
    });
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
