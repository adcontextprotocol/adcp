/**
 * Utility for injecting app config into HTML pages.
 *
 * This ensures nav.js can access user info synchronously for rendering
 * the navigation bar with proper auth state.
 */

import type { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auth is enabled if WorkOS credentials are configured
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD
);

// PostHog config - only enabled if API key is set
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || null;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

interface AppUser {
  id?: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Build the app config object from request user.
 * Works with req.user populated by optionalAuth middleware.
 */
export function buildAppConfig(user?: AppUser | null): {
  authEnabled: boolean;
  user: { id?: string; email: string; firstName?: string | null; lastName?: string | null; isAdmin: boolean } | null;
  posthog: { apiKey: string; host: string } | null;
} {
  let isAdmin = false;
  if (user) {
    const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
    isAdmin = adminEmails.includes(user.email.toLowerCase());
  }

  return {
    authEnabled: AUTH_ENABLED,
    user: user ? {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin,
    } : null,
    posthog: POSTHOG_API_KEY ? {
      apiKey: POSTHOG_API_KEY,
      host: POSTHOG_HOST,
    } : null,
  };
}

/**
 * Generate the script tag to inject app config into HTML.
 */
export function getAppConfigScript(user?: AppUser | null): string {
  const config = buildAppConfig(user);
  return `<script>window.__APP_CONFIG__=${JSON.stringify(config)};</script>`;
}

/**
 * Inline script that buffers errors before PostHog loads.
 * Must run synchronously before any other scripts.
 */
const EARLY_ERROR_BUFFER_SCRIPT = `<script>
(function(){
  window.__earlyErrors=[];
  window.onerror=function(m,u,l,c,e){window.__earlyErrors.push({message:m,source:u,lineno:l,colno:c,error:e});};
  window.addEventListener('unhandledrejection',function(e){window.__earlyErrors.push({type:'unhandledrejection',reason:e.reason});});
})();
</script>`;

/**
 * Inject app config into HTML string.
 * Inserts before </head> or before <body if no </head> found.
 * Also injects PostHog script if configured.
 */
export function injectConfigIntoHtml(html: string, user?: AppUser | null): string {
  const configScript = getAppConfigScript(user);

  // Add early error buffer (sync) and PostHog script (deferred) if API key is configured
  const posthogScripts = POSTHOG_API_KEY
    ? `${EARLY_ERROR_BUFFER_SCRIPT}\n<script src="/posthog-init.js" defer></script>`
    : '';

  const injectedScripts = `${configScript}\n${posthogScripts}`;

  if (html.includes("</head>")) {
    return html.replace("</head>", `${injectedScripts}\n</head>`);
  }
  return html.replace("<body", `${injectedScripts}\n<body`);
}

/**
 * Resolve path to a public HTML file.
 * Handles both tsx (source) and node (dist) execution contexts.
 */
export function getPublicFilePath(filename: string): string {
  // Check if we're running from source (tsx) or dist (node)
  // In tsx: __dirname is server/src/utils
  // In dist: __dirname is dist/utils
  const isRunningFromSource = __dirname.includes('server/src');

  if (isRunningFromSource) {
    // tsx: server/src/utils -> server/public
    return path.join(__dirname, "../../public", filename);
  } else {
    // dist: dist/utils -> server/public
    return path.join(__dirname, "../../server/public", filename);
  }
}

/**
 * Serve an HTML file with app config injected.
 * Use after optionalAuth middleware to have req.user populated.
 *
 * @example
 * router.get("/", optionalAuth, (req, res) => serveHtmlWithConfig(req, res, "chat.html"));
 */
export async function serveHtmlWithConfig(
  req: Request,
  res: Response,
  filename: string
): Promise<void> {
  const filePath = getPublicFilePath(filename);

  const html = await fs.readFile(filePath, "utf-8");
  const injectedHtml = injectConfigIntoHtml(html, req.user);

  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(injectedHtml);
}
