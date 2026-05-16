/**
 * Utility for injecting app config into HTML pages.
 *
 * This ensures nav.js can access user info synchronously for rendering
 * the navigation bar with proper auth state.
 */

import crypto from "crypto";
import { readFileSync } from "fs";
import type { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveEffectiveMembership } from "../db/org-filters.js";
import { resolvePrimaryOrganization } from "../db/users-db.js";
import { createLogger } from "../logger.js";
import { isWebUserAAOAdmin } from "../addie/mcp/admin-tools.js";

const logger = createLogger('html-config');

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
  isMember?: boolean;
  isAdmin?: boolean;
}

/**
 * Build the app config object from request user.
 * Works with req.user populated by optionalAuth middleware.
 */
export function buildAppConfig(user?: AppUser | null): {
  authEnabled: boolean;
  user: { id?: string; email: string; firstName?: string | null; lastName?: string | null; isAdmin: boolean; isMember: boolean } | null;
  posthog: { apiKey: string; host: string } | null;
} {
  // Trust a pre-resolved isAdmin (set by enrichUserWithAdmin / dev-user flag).
  // Fall back to ADMIN_EMAILS for callers that haven't enriched yet so we don't
  // regress from prior behavior.
  let isAdmin = false;
  if (user) {
    if (typeof user.isAdmin === 'boolean') {
      isAdmin = user.isAdmin;
    } else {
      const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
      isAdmin = adminEmails.includes(user.email.toLowerCase());
    }
  }

  return {
    authEnabled: AUTH_ENABLED,
    user: user ? {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin,
      isMember: !!user.isMember,
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
 * Compute a content hash for csrf.js so the script URL changes when the file
 * changes. Cached at module-load time — rebuild/redeploy gets a new hash.
 */
let _csrfScriptVersion: string | null = null;
function getCsrfScriptVersion(): string {
  if (_csrfScriptVersion) return _csrfScriptVersion;
  try {
    const csrfPath = getPublicFilePath("csrf.js");
    const buf = readFileSync(csrfPath);
    _csrfScriptVersion = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
  } catch {
    _csrfScriptVersion = String(Date.now());
  }
  return _csrfScriptVersion;
}

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

  // csrf.js patches fetch() to include X-CSRF-Token on state-changing requests.
  // Cache-bust the URL with a content hash so we never serve a stale
  // patched fetch wrapper to a returning visitor.
  const csrfScript = `<script src="/csrf.js?v=${getCsrfScriptVersion()}"></script>`;

  const injectedScripts = `${configScript}\n${csrfScript}\n${posthogScripts}`;

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
 * Resolve the admin flag for a user using the same rules as the requireAdmin
 * middleware: ADMIN_EMAILS env var OR membership in the aao-admin working
 * group. If the user already has isAdmin set (e.g. a dev user), trust it.
 */
export async function enrichUserWithAdmin(user: AppUser | null | undefined): Promise<AppUser | null | undefined> {
  if (!user) return user;
  if (typeof user.isAdmin === 'boolean') return user;

  const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
  if (adminEmails.includes(user.email.toLowerCase())) {
    user.isAdmin = true;
    return user;
  }

  if (user.id) {
    try {
      user.isAdmin = await isWebUserAAOAdmin(user.id);
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to resolve isAdmin via working group; defaulting to false');
      user.isAdmin = false;
    }
  } else {
    user.isAdmin = false;
  }
  return user;
}

/**
 * Enrich a user object with membership status from the database.
 * Checks both direct and inherited membership via the brand registry hierarchy.
 */
export async function enrichUserWithMembership(user: AppUser | null | undefined): Promise<AppUser | null | undefined> {
  if (!user?.id || user.isMember !== undefined) return user;
  try {
    const orgId = await resolvePrimaryOrganization(user.id);
    if (orgId) {
      const membership = await resolveEffectiveMembership(orgId);
      user.isMember = membership.is_member;
    } else {
      user.isMember = false;
    }
  } catch {
    user.isMember = false;
  }
  return user;
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

  await enrichUserWithMembership(req.user);
  await enrichUserWithAdmin(req.user);
  const html = await fs.readFile(filePath, "utf-8");
  const injectedHtml = injectConfigIntoHtml(html, req.user);

  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(injectedHtml);
}

/**
 * Meta tag data for server-side rendering of social sharing previews.
 * These values replace placeholder content in HTML templates so that
 * social crawlers (Slack, Twitter, LinkedIn, Facebook) see real content
 * instead of "Loading..." placeholders from client-side rendered SPAs.
 */
export interface MetaTagData {
  title: string;
  description: string;
  image?: string;
  url: string;
  type?: 'article' | 'website';
  author?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

/**
 * Escape HTML special characters for safe insertion into HTML attributes.
 */
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Replace an HTML tag by its opening prefix, substituting everything between
 * the prefix and the closing > (exclusive — the > is preserved from the original).
 * Uses indexOf instead of regex to avoid polynomial backtracking.
 */
function replaceTag(html: string, tagPrefix: string, replacement: string): string {
  const idx = html.toLowerCase().indexOf(tagPrefix.toLowerCase());
  if (idx === -1) return html;
  const closeIdx = html.indexOf('>', idx + tagPrefix.length);
  if (closeIdx === -1) return html;
  return html.substring(0, idx) + replacement + html.substring(closeIdx);
}

/**
 * Inject meta tags into HTML for social sharing previews.
 * Replaces placeholder values in og:*, twitter:*, and JSON-LD tags.
 */
export function injectMetaTagsIntoHtml(html: string, metaTags: MetaTagData): string {
  const safeTitle = escapeHtmlAttr(metaTags.title);
  const safeDesc = escapeHtmlAttr(metaTags.description);
  const safeImage = escapeHtmlAttr(metaTags.image || 'https://agenticadvertising.org/AAo-social.png');
  const safeUrl = escapeHtmlAttr(metaTags.url);

  let result = html;

  // Replace page title (preserve id attribute for client-side updates)
  result = result.replace(
    /<title[^>]*>Loading\.\.\.[^<]*<\/title>/i,
    `<title id="pageTitle">${safeTitle} | AgenticAdvertising.org</title>`
  );

  // Replace meta tags and canonical URL using indexOf-based matching
  result = replaceTag(result, '<meta name="description"', `<meta name="description" id="pageDescription" content="${safeDesc}"`);

  result = replaceTag(result, '<meta property="og:url"', `<meta property="og:url" id="ogUrl" content="${safeUrl}"`);
  result = replaceTag(result, '<meta property="og:title"', `<meta property="og:title" id="ogTitle" content="${safeTitle}"`);
  result = replaceTag(result, '<meta property="og:description"', `<meta property="og:description" id="ogDescription" content="${safeDesc}"`);
  result = replaceTag(result, '<meta property="og:image"', `<meta property="og:image" id="ogImage" content="${safeImage}"`);

  result = replaceTag(result, '<meta name="twitter:url"', `<meta name="twitter:url" id="twitterUrl" content="${safeUrl}"`);
  result = replaceTag(result, '<meta name="twitter:title"', `<meta name="twitter:title" id="twitterTitle" content="${safeTitle}"`);
  result = replaceTag(result, '<meta name="twitter:description"', `<meta name="twitter:description" id="twitterDescription" content="${safeDesc}"`);
  result = replaceTag(result, '<meta name="twitter:image"', `<meta name="twitter:image" id="twitterImage" content="${safeImage}"`);

  result = replaceTag(result, '<link rel="canonical"', `<link rel="canonical" id="canonicalUrl" href="${safeUrl}"`);

  // Update JSON-LD structured data if article type
  if (metaTags.type === 'article') {
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": metaTags.title,
      "description": metaTags.description,
      "url": metaTags.url,
      "datePublished": metaTags.publishedAt || new Date().toISOString(),
      "dateModified": metaTags.modifiedAt || metaTags.publishedAt || new Date().toISOString(),
      "author": metaTags.author ? {
        "@type": "Person",
        "name": metaTags.author
      } : {
        "@type": "Organization",
        "name": "AgenticAdvertising.org"
      },
      "publisher": {
        "@type": "Organization",
        "name": "AgenticAdvertising.org",
        "url": "https://agenticadvertising.org",
        "logo": {
          "@type": "ImageObject",
          "url": "https://agenticadvertising.org/AAo.svg"
        }
      },
      "image": safeImage,
      "mainEntityOfPage": {
        "@type": "WebPage",
        "@id": metaTags.url
      }
    };

    // Escape </script> sequences in JSON to prevent XSS
    const jsonString = JSON.stringify(jsonLd, null, 2).replace(/<\//g, '<\\/');
    const jsonLdOpen = '<script type="application/ld+json" id="articleJsonLd">';
    const jsonLdStart = result.indexOf(jsonLdOpen);
    if (jsonLdStart !== -1) {
      const jsonLdEnd = result.indexOf('</script>', jsonLdStart + jsonLdOpen.length);
      if (jsonLdEnd !== -1) {
        result = result.substring(0, jsonLdStart) +
          `${jsonLdOpen}\n${jsonString}\n</script>` +
          result.substring(jsonLdEnd + '</script>'.length);
      }
    }
  }

  return result;
}

/**
 * Serve an HTML file with app config AND meta tags injected.
 * Use for pages that need social sharing previews (perspectives, events, etc.).
 *
 * @example
 * router.get("/perspectives/:slug", optionalAuth, async (req, res) => {
 *   const article = await getArticle(req.params.slug);
 *   await serveHtmlWithMetaTags(req, res, "article.html", article ? {
 *     title: article.title,
 *     description: article.excerpt,
 *     url: `https://example.com/perspectives/${article.slug}`,
 *     type: 'article',
 *   } : undefined);
 * });
 */
export async function serveHtmlWithMetaTags(
  req: Request,
  res: Response,
  filename: string,
  metaTags?: MetaTagData
): Promise<void> {
  const filePath = getPublicFilePath(filename);

  await enrichUserWithMembership(req.user);
  await enrichUserWithAdmin(req.user);
  let html = await fs.readFile(filePath, "utf-8");

  // Inject meta tags first (if provided)
  if (metaTags) {
    html = injectMetaTagsIntoHtml(html, metaTags);
  }

  // Then inject app config
  html = injectConfigIntoHtml(html, req.user);

  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(html);
}
