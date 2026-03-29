/**
 * CSRF protection via double-submit cookie pattern.
 *
 * How it works:
 *  1. On every response, a random `csrf-token` cookie is set (non-httpOnly so
 *     the browser JS can read it).
 *  2. State-changing requests (POST / PUT / DELETE / PATCH) must echo the
 *     cookie value back as an `X-CSRF-Token` header.
 *  3. An attacker on a different origin can't read the cookie (same-origin
 *     policy), so they can't set the matching header.
 *
 * Requests that skip CSRF validation:
 *  - GET / HEAD / OPTIONS (safe methods)
 *  - Requests with an Authorization header (API-key auth, not cookie-based)
 *  - Webhook callbacks (external services posting to us)
 *  - Slack event/command handlers (verified by Slack signing secret)
 *  - MCP/agent endpoints (Bearer-token auth)
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { createLogger } from "../logger.js";

const logger = createLogger("csrf");

const CSRF_COOKIE = "csrf-token";
const CSRF_HEADER = "x-csrf-token";
const TOKEN_BYTES = 32;

/** Path prefixes that receive POSTs from external services (not browsers). */
const EXEMPT_PREFIXES = [
  "/api/webhooks/",      // Resend inbound, WorkOS webhooks
  "/api/slack/",         // Slack Bolt events, commands, interactions
  "/api/mcp/",           // MCP protocol endpoints
  "/api/oauth/",         // OAuth callback flows
  "/api/si/",            // Sponsored Intelligence (agent-to-agent)
  "/api/training-agent/", // Training agent MCP
  "/api/creative-agent/", // Creative agent MCP
  "/api/addie/v1/",      // LLM-compatible chat completions
];

/** Exact paths exempt from CSRF (not prefix-matched to avoid over-matching). */
const EXEMPT_EXACT = [
  "/mcp",                // MCP Streamable HTTP (Bearer-token auth)
  "/stripe-webhook",     // Stripe webhook (raw body route)
  "/auth/bridge-callback", // Cross-domain session bridge (origin-validated)
  "/token",              // OAuth token endpoint (mcpAuthRouter)
  "/register",           // OAuth dynamic client registration (mcpAuthRouter)
  "/verify-email-link",  // Email link verification (token-authenticated form POST from email)
];

function isExemptPath(path: string): boolean {
  return EXEMPT_EXACT.includes(path) ||
    EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Check whether the incoming request has a valid CSRF cookie.
 * Returns the cookie value if valid, null if missing/malformed.
 */
function getValidCookie(req: Request): string | null {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing && typeof existing === "string" && existing.length === TOKEN_BYTES * 2) {
    return existing;
  }
  return null;
}

/**
 * Set a fresh CSRF cookie on the response.
 */
function setNewCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,   // JS must be able to read this
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days, matches session cookie
  });
  return token;
}

/**
 * Express middleware — mount after cookieParser().
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const existingCookie = getValidCookie(req);

  // Safe methods — nothing to validate, just ensure cookie exists
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!existingCookie) {
      setNewCsrfCookie(res);
    }
    return next();
  }

  // Non-browser callers authenticated via Authorization header (API keys,
  // Bearer tokens) don't use cookies, so CSRF doesn't apply.
  if (req.headers.authorization) {
    return next();
  }

  // Webhook / external service callbacks
  if (isExemptPath(req.path)) {
    return next();
  }

  // If the cookie was missing/expired, the client can't have a valid header.
  // Set a fresh cookie and return it in the response body so the client can
  // retry without relying on document.cookie timing.
  if (!existingCookie) {
    const freshToken = setNewCsrfCookie(res);
    logger.warn(
      {
        method: req.method,
        path: req.path,
        reason: "cookie_missing",
        origin: req.headers.origin || null,
        referer: req.headers.referer || null,
        userAgent: req.headers["user-agent"] || null,
      },
      "CSRF validation failed: cookie missing or expired"
    );
    res.setHeader("X-CSRF-Retry", "true");
    res.status(403).json({ error: "CSRF validation failed", reason: "cookie_expired", token: freshToken });
    return;
  }

  // Validate: header must match cookie (timing-safe to prevent side-channel leakage)
  const headerValue = req.headers[CSRF_HEADER];
  if (
    !headerValue ||
    typeof headerValue !== "string" ||
    headerValue.length !== existingCookie.length ||
    !crypto.timingSafeEqual(Buffer.from(headerValue), Buffer.from(existingCookie))
  ) {
    logger.warn(
      {
        method: req.method,
        path: req.path,
        reason: headerValue ? "mismatch" : "header_missing",
        hasCookie: true,
        hasHeader: !!headerValue,
        origin: req.headers.origin || null,
        referer: req.headers.referer || null,
        userAgent: req.headers["user-agent"] || null,
      },
      "CSRF validation failed: token mismatch"
    );
    res.status(403).json({ error: "CSRF validation failed", reason: "token_mismatch" });
    return;
  }

  next();
}
