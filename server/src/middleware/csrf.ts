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

/** Paths that receive POSTs from external services (not browsers). */
const EXEMPT_PREFIXES = [
  "/api/webhooks/",      // Resend inbound, WorkOS webhooks
  "/api/slack/",         // Slack Bolt events, commands, interactions
  "/api/mcp/",           // MCP protocol endpoints
  "/mcp",                // MCP Streamable HTTP (Bearer-token auth)
  "/api/oauth/",         // OAuth callback flows
  "/api/si/",            // Sponsored Intelligence (agent-to-agent)
  "/api/training-agent/", // Training agent MCP
  "/api/creative-agent/", // Creative agent MCP
  "/api/addie/v1/",      // LLM-compatible chat completions
  "/stripe-webhook",     // Stripe webhook (raw body route)
  "/auth/bridge-callback", // Cross-domain session bridge (origin-validated)
  "/token",              // OAuth token endpoint (mcpAuthRouter)
  "/register",           // OAuth dynamic client registration (mcpAuthRouter)
];

function isExemptPath(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Set the CSRF cookie if it isn't already present.
 * Called on every request so the token is available before the first POST.
 */
function ensureCsrfCookie(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing && typeof existing === "string" && existing.length === TOKEN_BYTES * 2) {
    return existing;
  }

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
  const token = ensureCsrfCookie(req, res);

  // Safe methods — nothing to validate
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Non-browser callers authenticated via Authorization header (API keys,
  // Bearer tokens) don't use cookies, so CSRF doesn't apply.
  if (req.headers.authorization) {
    return next();
  }

  // Static admin API key (set by earlier middleware on req)
  if ((req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey) {
    return next();
  }

  // Webhook / external service callbacks
  if (isExemptPath(req.path)) {
    return next();
  }

  // Validate: header must match cookie
  const headerValue = req.headers[CSRF_HEADER];
  if (!headerValue || headerValue !== token) {
    logger.warn(
      { method: req.method, path: req.path },
      "CSRF token missing or mismatched"
    );
    res.status(403).json({ error: "CSRF validation failed" });
    return;
  }

  next();
}
