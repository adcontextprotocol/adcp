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
import { getPool } from "../db/client.js";

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
 * Enrich a user object with membership status from the database.
 */
export async function enrichUserWithMembership(user: AppUser | null | undefined): Promise<AppUser | null | undefined> {
  if (!user?.id || user.isMember !== undefined) return user;
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT o.workos_organization_id
       FROM users u
       JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE u.workos_user_id = $1
         AND o.subscription_status = 'active'
         AND o.is_personal = false`,
      [user.id]
    );
    user.isMember = result.rows.length > 0;
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
  const html = await fs.readFile(filePath, "utf-8");
  const injectedHtml = injectConfigIntoHtml(html, req.user);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
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

  // Replace meta description
  result = result.replace(
    /<meta name="description"[^>]*content="Loading\.\.\."/i,
    `<meta name="description" id="pageDescription" content="${safeDesc}"`
  );

  // Replace Open Graph tags
  result = result.replace(
    /<meta property="og:url"[^>]*content=""/i,
    `<meta property="og:url" id="ogUrl" content="${safeUrl}"`
  );
  result = result.replace(
    /<meta property="og:title"[^>]*content=""/i,
    `<meta property="og:title" id="ogTitle" content="${safeTitle}"`
  );
  result = result.replace(
    /<meta property="og:description"[^>]*content=""/i,
    `<meta property="og:description" id="ogDescription" content="${safeDesc}"`
  );
  result = result.replace(
    /<meta property="og:image"[^>]*content="[^"]*"/i,
    `<meta property="og:image" id="ogImage" content="${safeImage}"`
  );

  // Replace Twitter tags
  result = result.replace(
    /<meta name="twitter:url"[^>]*content=""/i,
    `<meta name="twitter:url" id="twitterUrl" content="${safeUrl}"`
  );
  result = result.replace(
    /<meta name="twitter:title"[^>]*content=""/i,
    `<meta name="twitter:title" id="twitterTitle" content="${safeTitle}"`
  );
  result = result.replace(
    /<meta name="twitter:description"[^>]*content=""/i,
    `<meta name="twitter:description" id="twitterDescription" content="${safeDesc}"`
  );
  result = result.replace(
    /<meta name="twitter:image"[^>]*content="[^"]*"/i,
    `<meta name="twitter:image" id="twitterImage" content="${safeImage}"`
  );

  // Replace canonical URL
  result = result.replace(
    /<link rel="canonical"[^>]*href=""/i,
    `<link rel="canonical" id="canonicalUrl" href="${safeUrl}"`
  );

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
    result = result.replace(
      /<script type="application\/ld\+json" id="articleJsonLd">[\s\S]*?<\/script>/,
      `<script type="application/ld+json" id="articleJsonLd">\n${jsonString}\n</script>`
    );
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
  let html = await fs.readFile(filePath, "utf-8");

  // Inject meta tags first (if provided)
  if (metaTags) {
    html = injectMetaTagsIntoHtml(html, metaTags);
  }

  // Then inject app config
  html = injectConfigIntoHtml(html, req.user);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(html);
}
