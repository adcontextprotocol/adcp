import express from "express";
import cookieParser from "cookie-parser";
import * as fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { WorkOS, DomainDataState } from "@workos-inc/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentService } from "./agent-service.js";
import { AgentValidator } from "./validator.js";
import { createMCPServer } from "./mcp-tools.js";
import { HealthChecker } from "./health.js";
import { CrawlerService } from "./crawler.js";
import { createLogger } from "./logger.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { PublisherTracker } from "./publishers.js";
import { PropertiesService } from "./properties.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { closeDatabase, getPool } from "./db/client.js";
import { CreativeAgentClient, SingleAgentClient } from "@adcp/client";
import type { Agent, AgentType, AgentWithStats, Company } from "./types.js";
import { isValidAgentType } from "./types.js";
import type { Server } from "http";
import { stripe, STRIPE_WEBHOOK_SECRET, createStripeCustomer, createCustomerPortalSession, createCustomerSession, getSubscriptionInfo, fetchAllPaidInvoices, fetchAllRefunds, getPendingInvoices, type RevenueEvent } from "./billing/stripe-client.js";
import Stripe from "stripe";
import { OrganizationDatabase, CompanyType, RevenueTier } from "./db/organization-db.js";
import { MemberDatabase } from "./db/member-db.js";
import { JoinRequestDatabase } from "./db/join-request-db.js";
import { SlackDatabase } from "./db/slack-db.js";
import { syncSlackUsers, getSyncStatus } from "./slack/sync.js";
import { isSlackConfigured, testSlackConnection } from "./slack/client.js";
import { handleSlashCommand } from "./slack/commands.js";
import { getCompanyDomain } from "./utils/email-domain.js";
import { requireAuth, requireAdmin, optionalAuth, invalidateSessionCache, isDevModeEnabled, getDevUser, getAvailableDevUsers, getDevSessionCookieName, DEV_USERS, type DevUserConfig } from "./middleware/auth.js";
import { invitationRateLimiter, orgCreationRateLimiter } from "./middleware/rate-limit.js";
import { validateOrganizationName, validateEmail } from "./middleware/validation.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
  notifyNewSubscription,
  notifyPaymentSucceeded,
  notifyPaymentFailed,
  notifySubscriptionCancelled,
} from "./notifications/billing.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAdminInsightsRouter } from "./routes/admin-insights.js";
import { createAdminOutboundRouter } from "./routes/admin-outbound.js";
import { createAddieAdminRouter } from "./routes/addie-admin.js";
import { createAddieChatRouter } from "./routes/addie-chat.js";
import { sendAccountLinkedMessage, invalidateMemberContextCache, getAddieBoltRouter, isAddieBoltReady } from "./addie/index.js";
import { createSlackRouter } from "./routes/slack.js";
import { createWebhooksRouter } from "./routes/webhooks.js";
import { createWorkOSWebhooksRouter } from "./routes/workos-webhooks.js";
import { createAdminSlackRouter, createAdminEmailRouter, createAdminFeedsRouter, createAdminNotificationChannelsRouter, createAdminUsersRouter, createAdminSettingsRouter, createAdminPerspectivesRouter } from "./routes/admin/index.js";
import { createPerspectivesRouter, createUserPerspectivesRouter } from "./routes/perspectives.js";
import { processFeedsToFetch } from "./addie/services/feed-fetcher.js";
import { processAlerts } from "./addie/services/industry-alerts.js";
import { createBillingRouter } from "./routes/billing.js";
import { createPublicBillingRouter } from "./routes/billing-public.js";
import { createOrganizationsRouter } from "./routes/organizations.js";
import { createEventsRouter } from "./routes/events.js";
import { createLatestRouter } from "./routes/latest.js";
import { createCommitteeRouters } from "./routes/committees.js";
import { sendWelcomeEmail, sendUserSignupEmail, emailDb } from "./notifications/email.js";
import { emailPrefsDb } from "./db/email-preferences-db.js";
import { processPendingResources, processRssPerspectives, processCommunityArticles } from "./addie/services/content-curator.js";
import { sendCommunityReplies } from "./addie/services/community-articles.js";
import { sendChannelMessage } from "./slack/client.js";
import { runTaskReminderJob } from "./addie/jobs/task-reminder.js";
import { runEngagementScoringJob } from "./addie/jobs/engagement-scoring.js";
import { notifyJoinRequest, notifyMemberAdded, notifySubscriptionThankYou } from "./slack/org-group-dm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('http-server');

/**
 * Validate slug format and check against reserved keywords
 */
function isValidSlug(slug: string): boolean {
  const reserved = ['admin', 'api', 'auth', 'dashboard', 'members', 'registry', 'onboarding'];
  if (reserved.includes(slug.toLowerCase())) {
    return false;
  }
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug.toLowerCase());
}

/**
 * Extract publisher validation stats from adagents.json validation result
 */
function extractPublisherStats(result: { valid: boolean; raw_data?: any }) {
  let agentCount = 0;
  let propertyCount = 0;
  let tagCount = 0;
  let propertyTypeCounts: Record<string, number> = {};

  if (result.valid && result.raw_data) {
    agentCount = result.raw_data.authorized_agents?.length || 0;
    propertyCount = result.raw_data.properties?.length || 0;
    tagCount = Object.keys(result.raw_data.tags || {}).length;

    // Count properties by type
    const properties = result.raw_data.properties || [];
    for (const prop of properties) {
      const propType = prop.property_type || 'unknown';
      propertyTypeCounts[propType] = (propertyTypeCounts[propType] || 0) + 1;
    }
  }

  return { agentCount, propertyCount, tagCount, propertyTypeCounts };
}

// Check if authentication is configured
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

// PostHog config - only enabled if API key is set
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || null;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

// Initialize WorkOS client only if authentication is enabled
const workos = AUTH_ENABLED ? new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
}) : null;
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || '';
const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const WORKOS_COOKIE_PASSWORD = process.env.WORKOS_COOKIE_PASSWORD || '';
// Allow insecure cookies for local Docker development
const ALLOW_INSECURE_COOKIES = process.env.ALLOW_INSECURE_COOKIES === 'true';

// Dev mode: bypass auth with a mock user for local testing
// Set DEV_USER_EMAIL and DEV_USER_ID in .env.local to enable
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const DEV_USER_ID = process.env.DEV_USER_ID;
const DEV_MODE_ENABLED = !!(DEV_USER_EMAIL && DEV_USER_ID);

// System user ID for audit logs from webhook/automated contexts
const SYSTEM_USER_ID = 'system';

// In-memory cache for WorkOS organization and user lookups
// Used to reduce API calls when enriching audit logs
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const workosOrgCache = new Map<string, CacheEntry<{ name: string }>>();
const workosUserCache = new Map<string, CacheEntry<{ displayName: string }>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedOrg(orgId: string): { name: string } | null {
  const entry = workosOrgCache.get(orgId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value;
  }
  workosOrgCache.delete(orgId);
  return null;
}

function setCachedOrg(orgId: string, name: string): void {
  workosOrgCache.set(orgId, {
    value: { name },
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getCachedUser(userId: string): { displayName: string } | null {
  const entry = workosUserCache.get(userId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value;
  }
  workosUserCache.delete(userId);
  return null;
}

function setCachedUser(userId: string, displayName: string): void {
  workosUserCache.set(userId, {
    value: { displayName },
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Upsert invoice data to local cache (org_invoices table).
 * Called from Stripe webhook handlers to keep invoice data in sync.
 */
async function upsertInvoiceCache(
  pool: ReturnType<typeof getPool>,
  invoice: Stripe.Invoice,
  workosOrgId: string | null,
  productName: string | null = null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO org_invoices (
        stripe_invoice_id,
        stripe_customer_id,
        workos_organization_id,
        status,
        amount_due,
        amount_paid,
        currency,
        invoice_number,
        hosted_invoice_url,
        invoice_pdf,
        product_name,
        customer_email,
        created_at,
        due_date,
        paid_at,
        voided_at,
        stripe_updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (stripe_invoice_id) DO UPDATE SET
        status = EXCLUDED.status,
        amount_due = EXCLUDED.amount_due,
        amount_paid = EXCLUDED.amount_paid,
        invoice_number = EXCLUDED.invoice_number,
        hosted_invoice_url = EXCLUDED.hosted_invoice_url,
        invoice_pdf = EXCLUDED.invoice_pdf,
        product_name = COALESCE(EXCLUDED.product_name, org_invoices.product_name),
        customer_email = EXCLUDED.customer_email,
        paid_at = EXCLUDED.paid_at,
        voided_at = EXCLUDED.voided_at,
        stripe_updated_at = NOW()`,
      [
        invoice.id,
        invoice.customer as string,
        workosOrgId,
        invoice.status,
        invoice.amount_due,
        invoice.amount_paid,
        invoice.currency,
        invoice.number || null,
        invoice.hosted_invoice_url || null,
        invoice.invoice_pdf || null,
        productName,
        typeof invoice.customer_email === 'string' ? invoice.customer_email : null,
        new Date(invoice.created * 1000),
        invoice.due_date ? new Date(invoice.due_date * 1000) : null,
        invoice.status === 'paid' && invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : null,
        invoice.status === 'void' ? new Date() : null,
      ]
    );
    logger.debug({ invoiceId: invoice.id, status: invoice.status }, 'Invoice cache updated');
  } catch (err) {
    logger.error({ err, invoiceId: invoice.id }, 'Failed to update invoice cache');
  }
}

/**
 * Build app config object for injection into HTML pages.
 * This allows nav.js to read config synchronously instead of making an async fetch.
 */
function buildAppConfig(user?: { id?: string; email: string; firstName?: string | null; lastName?: string | null } | null) {
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
 * Generate the script tags to inject app config and PostHog into HTML.
 */
function getAppConfigScript(user?: { id?: string; email: string; firstName?: string | null; lastName?: string | null } | null): string {
  const config = buildAppConfig(user);
  const configScript = `<script>window.__APP_CONFIG__=${JSON.stringify(config)};</script>`;

  // Add PostHog script if API key is configured
  const posthogScript = POSTHOG_API_KEY
    ? `<script src="/posthog-init.js" defer></script>`
    : '';

  return `${configScript}\n${posthogScript}`;
}

/**
 * Get user info from request for HTML config injection.
 * Checks dev mode first, then WorkOS session.
 * If session is refreshed, updates the cookie in the response.
 */
async function getUserFromRequest(
  req: express.Request,
  res?: express.Response
): Promise<{ id?: string; email: string; firstName?: string | null; lastName?: string | null } | null> {
  // Check dev mode first
  if (isDevModeEnabled()) {
    const devUser = getDevUser(req);
    if (devUser) {
      return devUser;
    }
  }

  // Then check WorkOS session
  const sessionCookie = req.cookies?.['wos-session'];
  if (sessionCookie && AUTH_ENABLED && workos) {
    try {
      const session = workos.userManagement.loadSealedSession({
        sessionData: sessionCookie,
        cookiePassword: WORKOS_COOKIE_PASSWORD,
      });

      // Try to authenticate with the current session
      let authResult = await session.authenticate();

      // If authentication failed (e.g., expired token), try to refresh
      if (!authResult.authenticated || !authResult.user) {
        try {
          const refreshResult = await session.refresh({
            cookiePassword: WORKOS_COOKIE_PASSWORD,
          });

          if (refreshResult.authenticated && refreshResult.sealedSession) {
            // Update the cookie with the refreshed session
            if (res) {
              res.cookie('wos-session', refreshResult.sealedSession, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
              });
            }

            // Re-authenticate with the new session
            const newSession = workos.userManagement.loadSealedSession({
              sessionData: refreshResult.sealedSession,
              cookiePassword: WORKOS_COOKIE_PASSWORD,
            });
            authResult = await newSession.authenticate();
          }
        } catch {
          // Refresh failed - continue without user
        }
      }

      if (authResult.authenticated && authResult.user) {
        return authResult.user;
      }
    } catch {
      // Session invalid or expired - continue without user
    }
  }

  return null;
}

export class HTTPServer {
  private app: express.Application;
  private server: Server | null = null;
  private agentService: AgentService;
  private validator: AgentValidator;
  private healthChecker: HealthChecker;
  private crawler: CrawlerService;
  private capabilityDiscovery: CapabilityDiscovery;
  private publisherTracker: PublisherTracker;
  private propertiesService: PropertiesService;
  private adagentsManager: AdAgentsManager;
  private contentCuratorIntervalId: NodeJS.Timeout | null = null;
  private feedFetcherIntervalId: NodeJS.Timeout | null = null;
  private feedFetcherInitialTimeoutId: NodeJS.Timeout | null = null;
  private alertProcessorIntervalId: NodeJS.Timeout | null = null;
  private alertProcessorInitialTimeoutId: NodeJS.Timeout | null = null;
  private taskReminderIntervalId: NodeJS.Timeout | null = null;
  private engagementScoringIntervalId: NodeJS.Timeout | null = null;

  constructor() {
    this.app = express();
    this.agentService = new AgentService();
    this.validator = new AgentValidator();
    this.adagentsManager = new AdAgentsManager();
    this.healthChecker = new HealthChecker();
    this.crawler = new CrawlerService();
    this.capabilityDiscovery = new CapabilityDiscovery();
    this.publisherTracker = new PublisherTracker();
    this.propertiesService = new PropertiesService();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Trust the first proxy (Fly.io) for accurate client IP detection
    // Required for express-rate-limit and other middleware that use req.ip
    this.app.set('trust proxy', 1);

    // Request logging for /api/me/member-profile to help diagnose issues
    this.app.use('/api/me/member-profile', (req, res, next) => {
      const startTime = Date.now();
      logger.debug({ method: req.method, path: req.path, query: req.query }, 'member-profile request received');

      // Log when response finishes
      res.on('finish', () => {
        logger.debug({
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startTime
        }, 'member-profile response sent');
      });

      next();
    });

    // Use JSON parser for all routes EXCEPT those that need raw body for signature verification
    // Limit increased to 10MB to support base64-encoded logo uploads in member profiles
    this.app.use((req, res, next) => {
      // Skip global JSON parser for routes that need raw body capture:
      // - Stripe webhooks: need raw body for webhook signature verification
      // - Resend inbound webhooks: need raw body for Svix signature verification
      // - WorkOS webhooks: need raw body for WorkOS signature verification
      // - Slack routes: need raw body for Slack signature verification
      //   (both JSON for events and URL-encoded for commands)
      if (req.path === '/api/webhooks/stripe' ||
          req.path === '/api/webhooks/resend-inbound' ||
          req.path === '/api/webhooks/workos' ||
          req.path.startsWith('/api/slack/')) {
        next();
      } else {
        express.json({ limit: '10mb' })(req, res, next);
      }
    });
    this.app.use(cookieParser());

    // Serve JSON schemas at /schemas/* from dist/schemas (built schemas)
    // In dev: __dirname is server/src, dist is at ../../dist
    // In prod: __dirname is dist, schemas are at ./schemas
    const distPath = process.env.NODE_ENV === 'production'
      ? __dirname
      : path.join(__dirname, "../../dist");
    const schemasPath = path.join(distPath, 'schemas');

    // Cache for schema version directories (refreshed every 60 seconds)
    let versionCache: { versions: string[], timestamp: number } | null = null;
    const CACHE_TTL_MS = 60 * 1000;

    async function getSchemaVersions(): Promise<string[]> {
      const now = Date.now();
      if (versionCache && (now - versionCache.timestamp) < CACHE_TTL_MS) {
        return versionCache.versions;
      }

      const entries = await fs.readdir(schemasPath, { withFileTypes: true });
      const versions = entries
        .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
        .map(e => e.name)
        .sort((a, b) => {
          // Sort by semver (descending)
          const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
          const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
          if (aMajor !== bMajor) return bMajor - aMajor;
          if (aMinor !== bMinor) return bMinor - aMinor;
          return bPatch - aPatch;
        });

      versionCache = { versions, timestamp: now };
      return versions;
    }

    function parseSemver(version: string): { major: number, minor: number, patch: number } {
      const [major, minor, patch] = version.split('.').map(Number);
      return { major, minor, patch };
    }

    function findMatchingVersion(versions: string[], requestedMajor: number, requestedMinor?: number): string | undefined {
      // Find the latest version that matches the requested major (and optionally minor)
      return versions.find(v => {
        const { major, minor } = parseSemver(v);
        if (major !== requestedMajor) return false;
        if (requestedMinor !== undefined && minor !== requestedMinor) return false;
        return true;
      });
    }

    // Middleware to resolve version aliases (e.g., v2.5 → 2.5.1)
    // This handles cases where symlinks don't exist (e.g., in Docker)
    this.app.use('/schemas', async (req, res, next) => {
      // Match version alias patterns: /v2/, /v2.5/, /v2.6/, /v1/
      const versionMatch = req.path.match(/^\/v(\d+)(?:\.(\d+))?(\/.*)?$/);
      if (!versionMatch) {
        return next();
      }

      const requestedMajor = parseInt(versionMatch[1], 10);
      const requestedMinor = versionMatch[2] ? parseInt(versionMatch[2], 10) : undefined;
      const restOfPath = versionMatch[3] || '/';

      // Special case: v1 always points to latest
      if (requestedMajor === 1 && requestedMinor === undefined) {
        req.url = '/latest' + restOfPath;
        return next();
      }

      try {
        const versions = await getSchemaVersions();
        const targetVersion = findMatchingVersion(versions, requestedMajor, requestedMinor);

        if (targetVersion) {
          req.url = '/' + targetVersion + restOfPath;
        }
      } catch {
        // If we can't read the directory, let static middleware handle it
      }
      next();
    });

    // Redirect version directory requests to index.json
    // e.g., /schemas/2.6.0/ → /schemas/2.6.0/index.json
    this.app.use('/schemas', (req, res, next) => {
      // Match paths like /2.6.0/ or /latest/ (directory requests)
      if (req.path.match(/^\/(\d+\.\d+\.\d+|latest)\/$/)) {
        return res.redirect(req.path + 'index.json');
      }
      next();
    });

    // Schema discovery endpoint - returns available versions and aliases
    this.app.get('/schemas/', async (req, res) => {
      try {
        const versions = await getSchemaVersions();
        const latestPerMinor: Record<string, string> = {};
        let latestMajorVersion: string | undefined;

        for (const version of versions) {
          const { major, minor } = parseSemver(version);
          const minorKey = `${major}.${minor}`;

          // First version in sorted list is the overall latest
          if (!latestMajorVersion) {
            latestMajorVersion = version;
          }

          // Track latest patch for each minor
          if (!latestPerMinor[minorKey]) {
            latestPerMinor[minorKey] = version;
          }
        }

        // Build aliases list
        const aliases: Array<{ alias: string, resolves_to: string, path: string }> = [];

        // v1 -> latest (backward compatibility)
        aliases.push({
          alias: "v1",
          resolves_to: "latest",
          path: "/schemas/v1/"
        });

        // Major version aliases (e.g., v2 -> 2.6.0)
        if (latestMajorVersion) {
          const { major } = parseSemver(latestMajorVersion);
          aliases.push({
            alias: `v${major}`,
            resolves_to: latestMajorVersion,
            path: `/schemas/v${major}/`
          });
        }

        // Minor version aliases (e.g., v2.5 -> 2.5.1)
        for (const [minorKey, version] of Object.entries(latestPerMinor)) {
          aliases.push({
            alias: `v${minorKey}`,
            resolves_to: version,
            path: `/schemas/v${minorKey}/`
          });
        }

        // Sort aliases for consistent output
        aliases.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { numeric: true }));

        res.json({
          versions: versions.map(v => ({
            version: v,
            path: `/schemas/${v}/`
          })),
          aliases,
          latest: {
            path: "/schemas/latest/",
            note: "Development version, may differ from released versions"
          }
        });
      } catch (error) {
        res.status(500).json({ error: "Failed to list schema versions" });
      }
    });

    this.app.use('/schemas', express.static(schemasPath));

    // Serve other static files (robots.txt, images, etc.)
    const staticPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../static")
      : path.join(__dirname, "../../static");
    this.app.use(express.static(staticPath));

    // Redirect .html URLs to clean URLs for pages that need template variable injection
    // Must be BEFORE static middleware to intercept these requests
    this.app.get('/dashboard.html', (req, res) => {
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      res.redirect('/dashboard' + queryString);
    });

    // Serve homepage and public assets at root
    // In prod: __dirname is dist, public is at ../server/public
    // In dev: __dirname is server/src, public is at ../public
    // Note: index: false prevents automatic index.html serving - we handle "/" route explicitly
    // to serve different homepages based on hostname (AAO vs AdCP)
    const publicPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../server/public")
      : path.join(__dirname, "../public");

    // Middleware to inject app config into HTML files
    // This runs optionalAuth to get user info, then serves HTML with config injected
    // Intercepts both .html requests and extensionless paths that map to .html files
    this.app.use(async (req, res, next) => {
      const urlPath = req.path;

      // Determine the file path to check
      let filePath: string;
      if (urlPath.endsWith('.html')) {
        filePath = path.join(publicPath, urlPath);
      } else if (!urlPath.includes('.')) {
        // Extensionless path - check if .html version exists
        filePath = path.join(publicPath, urlPath + '.html');
      } else {
        // Has an extension but not .html - skip
        return next();
      }

      try {
        // Check if file exists
        await fs.access(filePath);

        // Get user from session (if authenticated), passing res to update cookie if session is refreshed
        const user = await getUserFromRequest(req, res);

        // Read and inject config
        let html = await fs.readFile(filePath, 'utf-8');
        const configScript = getAppConfigScript(user);

        // Inject before </head>
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${configScript}\n</head>`);
        } else {
          // Fallback: inject at start of body
          html = html.replace('<body', `${configScript}\n<body`);
        }

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(html);
      } catch {
        // File doesn't exist, let next middleware handle it
        next();
      }
    });

    this.app.use(express.static(publicPath, { index: false }));
  }


  // Helper to check if request is from adcontextprotocol.org (requires redirect to AAO for auth)
  // Session cookies are scoped to agenticadvertising.org, so auth pages on AdCP must redirect
  private isAdcpDomain(req: express.Request): boolean {
    const hostname = req.hostname || '';
    return hostname.includes('adcontextprotocol') && !hostname.includes('localhost');
  }

  /**
   * Serve an HTML file with APP_CONFIG injected.
   * This ensures clean URL routes (like /membership) get the same config injection
   * as .html file requests handled by the middleware.
   */
  private async serveHtmlWithConfig(req: express.Request, res: express.Response, htmlFile: string): Promise<void> {
    const publicPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../server/public")
      : path.join(__dirname, "../public");
    const filePath = path.join(publicPath, htmlFile);

    try {
      // Get user from session (if authenticated), passing res to update cookie if session is refreshed
      const user = await getUserFromRequest(req, res);

      // Read and inject config
      let html = await fs.readFile(filePath, 'utf-8');
      const configScript = getAppConfigScript(user);

      // Inject before </head>
      if (html.includes('</head>')) {
        html = html.replace('</head>', `${configScript}\n</head>`);
      } else {
        // Fallback: inject at start of body
        html = html.replace('<body', `${configScript}\n<body`);
      }

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(html);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        logger.warn({ htmlFile }, 'HTML file not found');
        res.status(404).send('Not Found');
      } else {
        logger.error({ error, htmlFile }, 'Failed to serve HTML with config');
        res.status(500).send('Internal Server Error');
      }
    }
  }

  private setupRoutes(): void {
    // Authentication routes (only if configured)
    if (AUTH_ENABLED) {
      this.setupAuthRoutes();
      logger.info('Authentication enabled');
    } else {
      logger.warn('Authentication disabled - WORKOS environment variables not configured');
    }

    // Mount admin routes
    const { pageRouter, apiRouter } = createAdminRouter();
    this.app.use('/admin', pageRouter);      // Page routes: /admin/prospects
    this.app.use('/api/admin', apiRouter);   // API routes: /api/admin/prospects

    // Mount admin insights routes (member insights, goals, outreach)
    const { pageRouter: insightsPageRouter, apiRouter: insightsApiRouter } = createAdminInsightsRouter();
    this.app.use('/admin', insightsPageRouter);      // Page routes: /admin/insights, /admin/insight-types, etc.
    this.app.use('/api/admin', insightsApiRouter);   // API routes: /api/admin/insights, /api/admin/insight-types, etc.

    // Mount admin outbound planner routes (goals, rehearsal)
    const { pageRouter: outboundPageRouter, apiRouter: outboundApiRouter } = createAdminOutboundRouter();
    this.app.use('/admin', outboundPageRouter);          // Page routes: /admin/goals, /admin/rehearsal
    this.app.use('/api/admin/outbound', outboundApiRouter); // API routes: /api/admin/outbound/goals, /api/admin/outbound/rehearsal

    // Mount Addie admin routes
    const { pageRouter: addiePageRouter, apiRouter: addieApiRouter } = createAddieAdminRouter();
    this.app.use('/admin/addie', addiePageRouter);      // Page routes: /admin/addie
    this.app.use('/api/admin/addie', addieApiRouter);   // API routes: /api/admin/addie/*

    // Mount Addie chat routes (public chat interface)
    const { pageRouter: chatPageRouter, apiRouter: chatApiRouter } = createAddieChatRouter();
    this.app.use('/chat', chatPageRouter);              // Page routes: /chat
    this.app.use('/api/addie/chat', chatApiRouter);     // API routes: /api/addie/chat

    // Mount Slack routes (public webhook endpoints)
    // All Slack routes under /api/slack/ for consistency
    // Addie uses Bolt SDK - get its router if available
    const addieBoltRouter = getAddieBoltRouter();
    const { aaobotRouter, addieRouter: slackAddieRouter } = createSlackRouter(addieBoltRouter);
    this.app.use('/api/slack/aaobot', aaobotRouter);    // AAO bot: /api/slack/aaobot/commands, /api/slack/aaobot/events
    this.app.use('/api/slack/addie', slackAddieRouter); // Addie bot: /api/slack/addie/events (Bolt SDK)

    // Mount admin Slack, Email, Feeds, and Notification Channels routes
    const adminSlackRouter = createAdminSlackRouter();
    this.app.use('/api/admin/slack', adminSlackRouter); // Admin Slack: /api/admin/slack/*
    const adminEmailRouter = createAdminEmailRouter();
    this.app.use('/api/admin/email', adminEmailRouter); // Admin Email: /api/admin/email/*
    const adminFeedsRouter = createAdminFeedsRouter();
    this.app.use('/api/admin/feeds', adminFeedsRouter); // Admin Feeds: /api/admin/feeds/*
    const adminNotificationChannelsRouter = createAdminNotificationChannelsRouter();
    this.app.use('/api/admin/notification-channels', adminNotificationChannelsRouter); // Notification Channels: /api/admin/notification-channels/*
    const adminUsersRouter = createAdminUsersRouter();
    this.app.use('/api/admin/users', adminUsersRouter); // Admin Users: /api/admin/users/*
    const adminSettingsRouter = createAdminSettingsRouter();
    this.app.use('/api/admin/settings', adminSettingsRouter); // Admin Settings: /api/admin/settings/*
    const adminPerspectivesRouter = createAdminPerspectivesRouter();
    this.app.use('/api/admin/perspectives', adminPerspectivesRouter); // Admin Perspectives: /api/admin/perspectives/*

    // Mount public and user perspectives routes
    const perspectivesRouter = createPerspectivesRouter();
    this.app.use('/api/perspectives', perspectivesRouter); // Public Perspectives: /api/perspectives/*
    const userPerspectivesRouter = createUserPerspectivesRouter();
    this.app.use('/api/me/perspectives', userPerspectivesRouter); // User Perspectives: /api/me/perspectives/*

    // Mount billing routes (admin)
    const { pageRouter: billingPageRouter, apiRouter: billingApiRouter } = createBillingRouter();
    this.app.use('/admin', billingPageRouter);          // Page routes: /admin/products
    this.app.use('/api/admin', billingApiRouter);       // API routes: /api/admin/products

    // Mount public billing routes
    const publicBillingRouter = createPublicBillingRouter();
    this.app.use('/api', publicBillingRouter);          // Public API routes: /api/billing-products, /api/invoice-request, etc.

    // Mount organization routes
    const organizationsRouter = createOrganizationsRouter();
    this.app.use('/api/organizations', organizationsRouter); // Organization API routes: /api/organizations/*

    // Mount events routes
    const { pageRouter: eventsPageRouter, adminApiRouter: eventsAdminApiRouter, publicApiRouter: eventsPublicApiRouter } = createEventsRouter();
    this.app.use('/admin', eventsPageRouter);               // Admin page: /admin/events
    this.app.use('/api/admin/events', eventsAdminApiRouter); // Admin API: /api/admin/events/*
    this.app.use('/api/events', eventsPublicApiRouter);      // Public API: /api/events/*

    // Mount latest content routes (The Latest section)
    const { pageRouter: latestPageRouter, apiRouter: latestApiRouter } = createLatestRouter();
    this.app.use('/', latestPageRouter);                    // Page routes: /latest, /latest/:slug
    this.app.use('/api', latestApiRouter);                  // API routes: /api/latest/*

    // Mount webhook routes (external services like Resend, WorkOS)
    const webhooksRouter = createWebhooksRouter();
    this.app.use('/api/webhooks', webhooksRouter);      // Webhooks: /api/webhooks/resend-inbound
    const workosWebhooksRouter = createWorkOSWebhooksRouter();
    this.app.use('/api/webhooks', workosWebhooksRouter); // WorkOS: /api/webhooks/workos

    // UI page routes (serve with environment variables injected)
    // Auth-requiring pages on adcontextprotocol.org redirect to agenticadvertising.org
    // because session cookies are scoped to the AAO domain
    this.app.get('/onboarding', (req, res) => {
      if (this.isAdcpDomain(req)) {
        return res.redirect(`https://agenticadvertising.org/onboarding`);
      }
      res.redirect('/onboarding.html');
    });
    this.app.get('/team', (req, res) => {
      if (this.isAdcpDomain(req)) {
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        return res.redirect(`https://agenticadvertising.org/team${queryString}`);
      }
      res.redirect('/team.html' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''));
    });

    // Email click tracker - records clicks and redirects to destination
    this.app.get('/r/:trackingId', async (req, res) => {
      const { trackingId } = req.params;
      const destinationUrl = req.query.to as string;
      const linkName = req.query.ln as string;

      if (!destinationUrl) {
        logger.warn({ trackingId }, 'Click tracker missing destination URL');
        return res.redirect('/');
      }

      try {
        // Record the click
        await emailDb.recordClick({
          tracking_id: trackingId,
          link_name: linkName,
          destination_url: destinationUrl,
          ip_address: req.ip,
          user_agent: req.get('user-agent'),
          referrer: req.get('referer'),
          utm_source: req.query.utm_source as string,
          utm_medium: req.query.utm_medium as string,
          utm_campaign: req.query.utm_campaign as string,
        });

        logger.debug({ trackingId, linkName, destination: destinationUrl }, 'Email click recorded');
      } catch (error) {
        // Log but don't fail - always redirect even if tracking fails
        logger.error({ error, trackingId }, 'Failed to record email click');
      }

      // Always redirect to destination
      res.redirect(destinationUrl);
    });

    // ==================== Email Preferences & Unsubscribe ====================

    // One-click unsubscribe (no auth required) - POST for RFC 8058 compliance
    this.app.post('/unsubscribe/:token', async (req, res) => {
      const { token } = req.params;
      const { category } = req.body;

      try {
        if (category) {
          // Unsubscribe from specific category
          const success = await emailPrefsDb.unsubscribeFromCategory(token, category);
          if (success) {
            logger.info({ token: token.substring(0, 8) + '...', category }, 'User unsubscribed from category');
            return res.json({ success: true, message: `Unsubscribed from ${category}` });
          }
        } else {
          // Global unsubscribe
          const success = await emailPrefsDb.globalUnsubscribe(token);
          if (success) {
            logger.info({ token: token.substring(0, 8) + '...' }, 'User globally unsubscribed');
            return res.json({ success: true, message: 'Unsubscribed from all emails' });
          }
        }

        return res.status(404).json({ success: false, message: 'Invalid unsubscribe link' });
      } catch (error) {
        logger.error({ error, token: token.substring(0, 8) + '...' }, 'Error processing unsubscribe');
        return res.status(500).json({ success: false, message: 'Error processing unsubscribe' });
      }
    });

    // Unsubscribe page (GET - shows confirmation page, handles one-click via List-Unsubscribe-Post)
    this.app.get('/unsubscribe/:token', async (req, res) => {
      const { token } = req.params;

      try {
        const prefs = await emailPrefsDb.getUserPreferencesByToken(token);
        if (!prefs) {
          return res.status(404).send('Invalid unsubscribe link');
        }

        // Get categories for the preferences page
        const categories = await emailPrefsDb.getCategories();
        const userCategoryPrefs = prefs.workos_user_id
          ? await emailPrefsDb.getUserCategoryPreferences(prefs.workos_user_id)
          : categories.map(c => ({
              category_id: c.id,
              category_name: c.name,
              category_description: c.description,
              enabled: c.default_enabled,
              is_override: false,
            }));

        // Serve a simple preferences management page
        res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Preferences - AgenticAdvertising.org</title>
  <link rel="stylesheet" href="/design-system.css">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: var(--color-text); max-width: 600px; margin: 0 auto; padding: 20px; background: var(--color-bg-page); }
    h1 { color: var(--color-text-heading); }
    .card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .category { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--color-border); }
    .category:last-child { border-bottom: none; }
    .category-info h3 { margin: 0 0 4px 0; font-size: 16px; color: var(--color-text-heading); }
    .category-info p { margin: 0; font-size: 14px; color: var(--color-text-secondary); }
    .toggle { position: relative; width: 50px; height: 26px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--color-gray-300); border-radius: 26px; transition: 0.3s; }
    .toggle input:checked + .slider { background: var(--color-success-500); }
    .toggle .slider:before { position: absolute; content: ""; height: 20px; width: 20px; left: 3px; bottom: 3px; background: var(--color-bg-card); border-radius: 50%; transition: 0.3s; }
    .toggle input:checked + .slider:before { transform: translateX(24px); }
    .btn { display: inline-block; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; cursor: pointer; border: none; font-size: 16px; }
    .btn-danger { background: var(--color-error-500); color: white; }
    .btn-danger:hover { background: var(--color-error-600); }
    .btn-secondary { background: var(--color-bg-subtle); color: var(--color-text); border: 1px solid var(--color-border); }
    .success { background: var(--color-success-50); border: 1px solid var(--color-success-500); color: var(--color-success-700); padding: 12px; border-radius: 6px; margin-bottom: 20px; display: none; }
    .global-unsubscribe { margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--color-border); }
  </style>
</head>
<body>
  <h1>Email Preferences</h1>
  <p>Manage which emails you receive from AgenticAdvertising.org</p>

  <div id="success" class="success">Your preferences have been saved.</div>

  ${prefs.global_unsubscribe ? `
    <div class="card">
      <p><strong>You are currently unsubscribed from all emails.</strong></p>
      <p>You will only receive essential transactional emails (like security alerts).</p>
      <button class="btn btn-secondary" onclick="resubscribe()">Re-subscribe to emails</button>
    </div>
  ` : `
    <div class="card">
      ${userCategoryPrefs.map(cat => `
        <div class="category">
          <div class="category-info">
            <h3>${cat.category_name}</h3>
            <p>${cat.category_description || ''}</p>
          </div>
          <label class="toggle">
            <input type="checkbox" ${cat.enabled ? 'checked' : ''} onchange="toggleCategory('${cat.category_id}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      `).join('')}
    </div>

    <div class="global-unsubscribe">
      <p>Want to stop receiving all non-essential emails?</p>
      <button class="btn btn-danger" onclick="globalUnsubscribe()">Unsubscribe from all</button>
    </div>
  `}

  <script>
    const token = '${token}';

    async function toggleCategory(categoryId, enabled) {
      try {
        const res = await fetch('/api/email-preferences/category', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, category_id: categoryId, enabled })
        });
        if (res.ok) showSuccess();
      } catch (e) { console.error(e); }
    }

    async function globalUnsubscribe() {
      if (!confirm('Are you sure you want to unsubscribe from all emails?')) return;
      try {
        const res = await fetch('/unsubscribe/' + token, { method: 'POST' });
        if (res.ok) location.reload();
      } catch (e) { console.error(e); }
    }

    async function resubscribe() {
      try {
        const res = await fetch('/api/email-preferences/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) location.reload();
      } catch (e) { console.error(e); }
    }

    function showSuccess() {
      const el = document.getElementById('success');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
  </script>
</body>
</html>
        `);
      } catch (error) {
        logger.error({ error }, 'Error rendering unsubscribe page');
        res.status(500).send('Error loading preferences');
      }
    });

    // Update category preference via token (no auth required)
    this.app.post('/api/email-preferences/category', async (req, res) => {
      const { token, category_id, enabled } = req.body;

      if (!token || !category_id || enabled === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      try {
        const prefs = await emailPrefsDb.getUserPreferencesByToken(token);
        if (!prefs) {
          return res.status(404).json({ error: 'Invalid token' });
        }

        await emailPrefsDb.setCategoryPreference({
          workos_user_id: prefs.workos_user_id,
          email: prefs.email,
          category_id,
          enabled,
        });

        // Invalidate Addie's member context cache - email preferences changed
        invalidateMemberContextCache();

        logger.info({ userId: prefs.workos_user_id, category_id, enabled }, 'Category preference updated');
        res.json({ success: true });
      } catch (error) {
        logger.error({ error }, 'Error updating category preference');
        res.status(500).json({ error: 'Error updating preference' });
      }
    });

    // Resubscribe via token (no auth required)
    this.app.post('/api/email-preferences/resubscribe', async (req, res) => {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Missing token' });
      }

      try {
        const prefs = await emailPrefsDb.getUserPreferencesByToken(token);
        if (!prefs) {
          return res.status(404).json({ error: 'Invalid token' });
        }

        await emailPrefsDb.resubscribe(prefs.workos_user_id);

        // Invalidate Addie's member context cache - email preferences changed
        invalidateMemberContextCache();

        logger.info({ userId: prefs.workos_user_id }, 'User resubscribed');
        res.json({ success: true });
      } catch (error) {
        logger.error({ error }, 'Error processing resubscribe');
        res.status(500).json({ error: 'Error processing resubscribe' });
      }
    });

    // GET /api/dev-mode - Get dev mode info (for UI dev user switcher)
    this.app.get('/api/dev-mode', (req, res) => {
      if (!isDevModeEnabled()) {
        return res.status(404).json({
          enabled: false,
          message: 'Dev mode is not enabled',
        });
      }

      const devUser = getDevUser(req);
      const availableUsers = getAvailableDevUsers();

      res.json({
        enabled: true,
        current_user: devUser ? {
          key: Object.entries(availableUsers).find(([, u]) => u.id === devUser.id)?.[0] || 'unknown',
          ...devUser,
        } : null,
        available_users: Object.entries(availableUsers).map(([key, user]) => ({
          key,
          ...user,
          is_current: devUser ? user.id === devUser.id : false,
        })),
        switch_hint: 'Log out and log in as a different user at /auth/login',
      });
    });

    // Get email categories (public)
    this.app.get('/api/email-preferences/categories', async (req, res) => {
      try {
        const categories = await emailPrefsDb.getCategories();
        res.json({ categories });
      } catch (error) {
        logger.error({ error }, 'Error fetching email categories');
        res.status(500).json({ error: 'Error fetching categories' });
      }
    });

    // Get user's email preferences (authenticated)
    this.app.get('/api/email-preferences', requireAuth, async (req, res) => {
      try {
        const userId = (req as any).user.id;
        const userEmail = (req as any).user.email;

        // Get or create preferences
        const prefs = await emailPrefsDb.getOrCreateUserPreferences({
          workos_user_id: userId,
          email: userEmail,
        });

        // Get category preferences
        const categoryPrefs = await emailPrefsDb.getUserCategoryPreferences(userId);

        res.json({
          global_unsubscribe: prefs.global_unsubscribe,
          categories: categoryPrefs,
        });
      } catch (error) {
        logger.error({ error }, 'Error fetching user preferences');
        res.status(500).json({ error: 'Error fetching preferences' });
      }
    });

    // Update user's email preferences (authenticated)
    this.app.post('/api/email-preferences', requireAuth, async (req, res) => {
      try {
        const userId = (req as any).user.id;
        const userEmail = (req as any).user.email;
        const { category_id, enabled } = req.body;

        if (!category_id || enabled === undefined) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        await emailPrefsDb.setCategoryPreference({
          workos_user_id: userId,
          email: userEmail,
          category_id,
          enabled,
        });

        // Invalidate Addie's member context cache - email preferences changed
        invalidateMemberContextCache();

        res.json({ success: true });
      } catch (error) {
        logger.error({ error }, 'Error updating preferences');
        res.status(500).json({ error: 'Error updating preferences' });
      }
    });

    // Resubscribe for authenticated users
    this.app.post('/api/email-preferences/resubscribe-me', requireAuth, async (req, res) => {
      try {
        const userId = (req as any).user.id;

        await emailPrefsDb.resubscribe(userId);

        // Invalidate Addie's member context cache - email preferences changed
        invalidateMemberContextCache();

        logger.info({ userId }, 'User resubscribed via dashboard');
        res.json({ success: true });
      } catch (error) {
        logger.error({ error }, 'Error processing resubscribe');
        res.status(500).json({ error: 'Error processing resubscribe' });
      }
    });

    this.app.get('/dashboard', async (req, res) => {
      // Redirect to AAO for auth-requiring pages when on AdCP domain
      if (this.isAdcpDomain(req)) {
        return res.redirect('https://agenticadvertising.org/dashboard');
      }
      try {
        const fs = await import('fs/promises');
        const dashboardPath = process.env.NODE_ENV === 'production'
          ? path.join(__dirname, '../server/public/dashboard.html')
          : path.join(__dirname, '../public/dashboard.html');
        let html = await fs.readFile(dashboardPath, 'utf-8');

        // Replace template variables with environment values
        html = html
          .replace('{{STRIPE_PUBLISHABLE_KEY}}', process.env.STRIPE_PUBLISHABLE_KEY || '')
          .replace('{{STRIPE_PRICING_TABLE_ID}}', process.env.STRIPE_PRICING_TABLE_ID || '')
          .replace('{{STRIPE_PRICING_TABLE_ID_INDIVIDUAL}}', process.env.STRIPE_PRICING_TABLE_ID_INDIVIDUAL || process.env.STRIPE_PRICING_TABLE_ID || '');

        // Inject user config for nav.js, passing res to update cookie if session is refreshed
        const user = await getUserFromRequest(req, res);
        const configScript = getAppConfigScript(user);
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${configScript}\n</head>`);
        }

        // Prevent caching to ensure template variables are always fresh
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(html);
      } catch (error) {
        logger.error({ err: error }, 'Error serving dashboard');
        res.status(500).send('Error loading dashboard');
      }
    });

    // Dashboard sub-pages with sidebar navigation
    // Helper to serve dashboard pages with template variable replacement
    const serveDashboardPage = async (req: express.Request, res: express.Response, filename: string) => {
      if (this.isAdcpDomain(req)) {
        return res.redirect(`https://agenticadvertising.org/dashboard/${filename.replace('dashboard-', '').replace('.html', '')}`);
      }
      try {
        const pagePath = process.env.NODE_ENV === 'production'
          ? path.join(__dirname, `../server/public/${filename}`)
          : path.join(__dirname, `../public/${filename}`);
        let html = await fs.readFile(pagePath, 'utf-8');

        // Replace template variables (for billing page with Stripe)
        html = html
          .replace(/\{\{STRIPE_PUBLISHABLE_KEY\}\}/g, process.env.STRIPE_PUBLISHABLE_KEY || '')
          .replace(/\{\{STRIPE_PRICING_TABLE_ID\}\}/g, process.env.STRIPE_PRICING_TABLE_ID || '')
          .replace(/\{\{STRIPE_PRICING_TABLE_ID_INDIVIDUAL\}\}/g, process.env.STRIPE_PRICING_TABLE_ID_INDIVIDUAL || process.env.STRIPE_PRICING_TABLE_ID || '');

        // Inject user config for nav.js, passing res to update cookie if session is refreshed
        const user = await getUserFromRequest(req, res);
        const configScript = getAppConfigScript(user);
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${configScript}\n</head>`);
        }

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(html);
      } catch (error) {
        logger.error({ err: error, filename }, 'Error serving dashboard page');
        res.status(500).send('Error loading page');
      }
    };

    this.app.get('/dashboard/settings', (req, res) => serveDashboardPage(req, res, 'dashboard-settings.html'));
    this.app.get('/dashboard/membership', (req, res) => serveDashboardPage(req, res, 'dashboard-membership.html'));
    // Redirect old billing path to new membership path
    this.app.get('/dashboard/billing', (req, res) => {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      res.redirect(301, `/dashboard/membership${query}`);
    });
    this.app.get('/dashboard/emails', (req, res) => serveDashboardPage(req, res, 'dashboard-emails.html'));

    // API endpoints

    // Public config endpoint - returns feature flags and auth state for nav
    this.app.get("/api/config", optionalAuth, (req, res) => {
      // Prevent caching - auth state changes on login/logout
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // User is populated by optionalAuth middleware if authenticated
      let isAdmin = false;
      if (req.user) {
        const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
        isAdmin = adminEmails.includes(req.user.email.toLowerCase());
      }

      const user = req.user ? {
        id: req.user.id,
        email: req.user.email,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        isAdmin,
      } : null;

      res.json({
        authEnabled: AUTH_ENABLED,
        user,
      });
    });

    this.app.get("/api/agents/:type/:name", async (req, res) => {
      const agentId = `${req.params.type}/${req.params.name}`;
      const agent = await this.agentService.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const withHealth = req.query.health === "true";
      if (!withHealth) {
        return res.json(agent);
      }

      const [health, stats] = await Promise.all([
        this.healthChecker.checkHealth(agent),
        this.healthChecker.getStats(agent),
      ]);

      res.json({ ...agent, health, stats });
    });

    this.app.post("/api/validate", async (req, res) => {
      const { domain, agent_url } = req.body;

      if (!domain || !agent_url) {
        return res.status(400).json({
          error: "Missing required fields: domain and agent_url",
        });
      }

      try {
        const result = await this.validator.validate(domain, agent_url);
        res.json(result);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Validation failed",
        });
      }
    });


    this.app.get("/api/agents/:id/properties", async (req, res) => {
      const agentId = req.params.id;
      const agent = await this.agentService.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Get properties and publisher domains from database (populated by crawler)
      const federatedIndex = this.crawler.getFederatedIndex();
      const [properties, publisherDomains] = await Promise.all([
        federatedIndex.getPropertiesForAgent(agent.url),
        federatedIndex.getPublisherDomainsForAgent(agent.url),
      ]);

      res.json({
        agent_id: agentId,
        agent_url: agent.url,
        properties,
        publisher_domains: publisherDomains,
        count: properties.length,
      });
    });

    // Crawler endpoints
    this.app.post("/api/crawler/run", async (req, res) => {
      const agents = await this.agentService.listAgents("sales");
      const result = await this.crawler.crawlAllAgents(agents);
      res.json(result);
    });

    this.app.get("/api/crawler/status", (req, res) => {
      res.json(this.crawler.getStatus());
    });

    this.app.get("/api/stats", async (req, res) => {
      const agents = await this.agentService.listAgents();
      const byType = {
        creative: agents.filter((a) => a.type === "creative").length,
        signals: agents.filter((a) => a.type === "signals").length,
        sales: agents.filter((a) => a.type === "sales").length,
      };

      res.json({
        total: agents.length,
        by_type: byType,
        cache: this.validator.getCacheStats(),
      });
    });

    // Capability endpoints
    this.app.get("/api/agents/:id/capabilities", async (req, res) => {
      const agentId = req.params.id;
      const agent = await this.agentService.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      try {
        const profile = await this.capabilityDiscovery.discoverCapabilities(agent);
        res.json(profile);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Capability discovery failed",
        });
      }
    });

    this.app.post("/api/capabilities/discover-all", async (req, res) => {
      const agents = await this.agentService.listAgents();
      try {
        const profiles = await this.capabilityDiscovery.discoverAll(agents);
        res.json({
          total: profiles.size,
          profiles: Array.from(profiles.values()),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Bulk discovery failed",
        });
      }
    });

    // Legacy publisher endpoints removed - use /api/registry/publishers instead
    // The old /api/publishers was for adagents.json validation but was unused





    // Simple REST API endpoint - for web apps and quick integrations
    this.app.get("/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const agents = await this.agentService.listAgents(type);

      res.json({
        agents,
        count: agents.length,
        by_type: {
          creative: agents.filter(a => a.type === "creative").length,
          signals: agents.filter(a => a.type === "signals").length,
          sales: agents.filter(a => a.type === "sales").length,
        }
      });
    });

    // MCP endpoint - for AI agents to discover other agents
    // Uses StreamableHTTPServerTransport from the MCP SDK for stateless HTTP transport
    
    // CORS preflight for MCP endpoint
    this.app.options("/mcp", (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
      res.status(204).end();
    });

    // MCP POST handler - stateless mode (new server/transport per request)
    this.app.post("/mcp", async (req, res) => {
      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');

      try {
        // Create a new MCP server and transport for each request (stateless mode)
        const server = createMCPServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode - no sessions
        });

        // Connect server to transport
        await server.connect(transport);

        // Handle the request
        await transport.handleRequest(req, res, req.body);

        // Clean up after response is sent
        res.on('close', () => {
          transport.close();
          server.close();
        });
      } catch (error: any) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error?.message || "Internal error",
            },
          });
        }
      }
    });

    // MCP GET handler - not supported in stateless mode
    this.app.get("/mcp", (req, res) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not allowed. Use POST for MCP requests.",
        },
      });
    });

    // MCP DELETE handler - not needed in stateless mode
    this.app.delete("/mcp", (req, res) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: "Method not allowed. Session management not supported in stateless mode.",
        },
      });
    });

    // Health check - verifies critical services are operational
    this.app.get("/health", async (req, res) => {
      const checks: Record<string, boolean> = {};
      let allHealthy = true;

      // Check database connectivity
      try {
        const pool = getPool();
        await pool.query('SELECT 1');
        checks.database = true;
      } catch {
        checks.database = false;
        allHealthy = false;
      }

      // Check Addie status
      checks.addie = isAddieBoltReady();
      if (!checks.addie) {
        allHealthy = false;
      }

      // Return appropriate status code
      const statusCode = allHealthy ? 200 : 503;
      res.status(statusCode).json({
        status: allHealthy ? "ok" : "degraded",
        checks,
        registry: {
          mode: "database",
          using_database: true,
        },
      });
    });

    // Homepage route - serve different homepage based on host
    // agenticadvertising.org (beta): Org-focused homepage
    // adcontextprotocol.org (production): Protocol-focused homepage
    this.app.get("/", async (req, res) => {
      const hostname = req.hostname || '';
      const betaOverride = req.query.beta;

      // Determine if this is the beta/org site
      // Beta sites: agenticadvertising.org, localhost (for testing)
      // Production sites: adcontextprotocol.org
      let isBetaSite: boolean;
      if (betaOverride !== undefined) {
        isBetaSite = betaOverride !== 'false';
      } else {
        isBetaSite = hostname.includes('agenticadvertising') ||
                     hostname === 'localhost' ||
                     hostname === '127.0.0.1';
      }

      // Beta site gets org-focused homepage, production gets protocol homepage
      const homepageFile = isBetaSite ? 'org-index.html' : 'index.html';
      await this.serveHtmlWithConfig(req, res, homepageFile);
    });

    // Registry UI route - serve registry.html at /registry
    this.app.get("/registry", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'registry.html');
    });

    // AdAgents Manager UI route - serve adagents.html at /adagents
    this.app.get("/adagents", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'adagents.html');
    });

    // Member Profile UI route - serve member-profile.html at /member-profile
    this.app.get("/member-profile", async (req, res) => {
      // Redirect to AAO for auth-requiring pages when on AdCP domain
      if (this.isAdcpDomain(req)) {
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        return res.redirect(`https://agenticadvertising.org/member-profile${queryString}`);
      }
      await this.serveHtmlWithConfig(req, res, 'member-profile.html');
    });

    // Member Directory UI route - serve members.html at /members
    this.app.get("/members", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'members.html');
    });

    // Individual member profile page
    this.app.get("/members/:slug", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'members.html');
    });

    // Publishers registry page
    this.app.get("/publishers", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'publishers.html');
    });

    // Properties registry page
    this.app.get("/properties", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'properties.html');
    });

    // About AAO page - serve about.html at /about
    this.app.get("/about", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'about.html');
    });

// Membership page - serve membership.html at /membership
    this.app.get("/membership", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'membership.html');
    });

    // Governance page - serve governance.html at /governance
    this.app.get("/governance", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'governance.html');
    });

    // Legacy redirects to The Latest section
    this.app.get("/perspectives", (req, res) => {
      res.redirect(301, "/latest/research");
    });
    this.app.get("/perspectives/:slug", (req, res) => {
      res.redirect(301, "/latest/research");
    });
    this.app.get("/insights", (req, res) => {
      res.redirect(301, "/latest/research");
    });
    this.app.get("/insights/:slug", (req, res) => {
      res.redirect(301, "/latest/research");
    });

    // Events section
    this.app.get("/events", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'events.html');
    });

    this.app.get("/events/:slug", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'event-detail.html');
    });

    // Working Groups pages - public list, detail pages handled by single HTML
    this.app.get("/working-groups", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'working-groups.html');
    });

    // Committees page (unified view for working groups, councils, chapters)
    this.app.get("/committees", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'committees.html');
    });

    // Legacy routes - redirect to committees page with type filter
    this.app.get("/councils", (req, res) => {
      res.redirect(301, '/committees?type=council');
    });

    this.app.get("/chapters", (req, res) => {
      res.redirect(301, '/committees?type=chapter');
    });

    // Industry Gatherings page (events with attendee groups)
    this.app.get("/industry-gatherings", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'industry-gatherings.html');
    });

    this.app.get("/working-groups/:slug", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'working-groups/detail.html');
    });

    // Working group management page (leaders only - auth check happens client-side via API)
    this.app.get("/working-groups/:slug/manage", async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'working-groups/manage.html');
    });

    // AdAgents API Routes
    // Validate domain's adagents.json
    this.app.post("/api/adagents/validate", async (req, res) => {
      try {
        const { domain } = req.body;

        if (!domain || domain.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Domain is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({ domain }, 'Validating adagents.json for domain');

        // Validate the domain's adagents.json
        const validation = await this.adagentsManager.validateDomain(domain);

        let agentCards = undefined;

        // If adagents.json is found and has agents, validate their cards
        if (validation.valid && validation.raw_data?.authorized_agents?.length > 0) {
          logger.info({ agentCount: validation.raw_data.authorized_agents.length }, 'Validating agent cards');
          agentCards = await this.adagentsManager.validateAgentCards(validation.raw_data.authorized_agents);
        }

        return res.json({
          success: true,
          data: {
            domain: validation.domain,
            found: validation.status_code === 200,
            validation,
            agent_cards: agentCards,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to validate domain:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Create adagents.json file
    this.app.post("/api/adagents/create", async (req, res) => {
      try {
        const {
          authorized_agents,
          include_schema = true,
          include_timestamp = true,
          properties,
        } = req.body;

        if (!authorized_agents || !Array.isArray(authorized_agents)) {
          return res.status(400).json({
            success: false,
            error: 'authorized_agents array is required',
            timestamp: new Date().toISOString(),
          });
        }

        if (authorized_agents.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'At least one authorized agent is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({
          agentCount: authorized_agents.length,
          propertyCount: properties?.length || 0,
        }, 'Creating adagents.json');

        // Validate the proposed structure
        const validation = this.adagentsManager.validateProposed(authorized_agents);

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            error: `Validation failed: ${validation.errors.map((e: any) => e.message).join(', ')}`,
            timestamp: new Date().toISOString(),
          });
        }

        // Create the adagents.json content
        const adagentsJson = this.adagentsManager.createAdAgentsJson(
          authorized_agents,
          include_schema,
          include_timestamp,
          properties
        );

        return res.json({
          success: true,
          data: {
            success: true,
            adagents_json: adagentsJson,
            validation,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to create adagents.json:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Validate agent cards only (utility endpoint)
    this.app.post("/api/adagents/validate-cards", async (req, res) => {
      try {
        const { agent_urls } = req.body;

        if (!agent_urls || !Array.isArray(agent_urls) || agent_urls.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'agent_urls array with at least one URL is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({ cardCount: agent_urls.length }, 'Validating agent cards');

        const agents = agent_urls.map((url: string) => ({ url, authorized_for: 'validation' }));
        const agentCards = await this.adagentsManager.validateAgentCards(agents);

        return res.json({
          success: true,
          data: {
            agent_cards: agentCards,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to validate agent cards:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Stripe Webhooks (independent of WorkOS auth)
    // POST /api/webhooks/stripe - Handle Stripe webhooks
    this.app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        logger.warn('Stripe not configured for webhooks');
        return res.status(400).json({ error: 'Stripe not configured' });
      }

      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }

      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        logger.error({ err }, 'Webhook signature verification failed');
        return res.status(400).json({ error: 'Webhook signature verification failed' });
      }

      logger.info({ eventType: event.type }, 'Stripe webhook event received');

      // Initialize database clients
      const orgDb = new OrganizationDatabase();
      const pool = getPool();

      try {
        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            logger.info({
              customer: subscription.customer,
              status: subscription.status,
              eventType: event.type,
            }, 'Processing subscription event');

            // For subscription created, record agreement acceptance atomically
            if (event.type === 'customer.subscription.created') {
              const customerId = subscription.customer as string;

              // Try to find org by stripe_customer_id first
              let org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              // If not found, look up by workos_organization_id in Stripe customer metadata
              if (!org) {
                logger.info({ customerId }, 'Org not found by customer ID, checking Stripe metadata');
                const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                const workosOrgId = customer.metadata?.workos_organization_id;

                if (workosOrgId) {
                  org = await orgDb.getOrganization(workosOrgId);
                  if (org) {
                    // Link the Stripe customer ID to the organization
                    await orgDb.setStripeCustomerId(workosOrgId, customerId);
                    logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization');
                  }
                }
              }

              if (org) {
                // Get agreement info from organization's pending fields
                // (set when user checked the agreement checkbox)
                let agreementVersion = org.pending_agreement_version || '1.0';
                let agreementAcceptedAt = org.pending_agreement_accepted_at || new Date();

                // If no pending agreement, use current version
                if (!org.pending_agreement_version) {
                  const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
                  if (currentAgreement) {
                    agreementVersion = currentAgreement.version;
                  }
                }

                // Get customer info from Stripe to find user email
                const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                const userEmail = customer.email || 'unknown@example.com';

                // Warn if using fallback email - indicates missing customer data
                if (!customer.email) {
                  logger.warn({
                    customerId,
                    subscriptionId: subscription.id,
                    orgId: org.workos_organization_id,
                  }, 'Using fallback email for subscription - customer has no email address');
                }

                // Get WorkOS user ID from email
                // Note: In production, we'd need a more robust way to link Stripe customer to WorkOS user
                // For now, we'll use the email from the customer record
                try {
                  const users = await workos!.userManagement.listUsers({ email: userEmail });
                  const workosUser = users.data[0];

                  if (workosUser) {
                    // Record membership agreement acceptance
                    try {
                      await orgDb.recordUserAgreementAcceptance({
                        workos_user_id: workosUser.id,
                        email: userEmail,
                        agreement_type: 'membership',
                        agreement_version: agreementVersion,
                        workos_organization_id: org.workos_organization_id,
                        // Note: IP and user-agent not available in webhook context
                      });
                    } catch (agreementError) {
                      // CRITICAL: Agreement recording failed but subscription already exists
                      // This needs manual intervention to fix the inconsistent state
                      logger.error({
                        error: agreementError,
                        orgId: org.workos_organization_id,
                        subscriptionId: subscription.id,
                        userEmail,
                        agreementVersion,
                      }, 'CRITICAL: Failed to record agreement acceptance - subscription exists but agreement not recorded. Manual intervention required.');
                      throw agreementError; // Re-throw to prevent further operations
                    }

                    // Update organization record
                    await orgDb.updateOrganization(org.workos_organization_id, {
                      agreement_signed_at: agreementAcceptedAt,
                      agreement_version: agreementVersion,
                    });

                    // Store agreement metadata in Stripe subscription
                    await stripe.subscriptions.update(subscription.id, {
                      metadata: {
                        workos_organization_id: org.workos_organization_id,
                        membership_agreement_version: agreementVersion,
                        membership_agreement_accepted_at: agreementAcceptedAt.toISOString(),
                      }
                    });

                    logger.info({
                      orgId: org.workos_organization_id,
                      subscriptionId: subscription.id,
                      agreementVersion,
                      userEmail,
                    }, 'Subscription created - membership agreement recorded atomically');

                    // Record audit log for subscription creation
                    await orgDb.recordAuditLog({
                      workos_organization_id: org.workos_organization_id,
                      workos_user_id: workosUser.id,
                      action: 'subscription_created',
                      resource_type: 'subscription',
                      resource_id: subscription.id,
                      details: {
                        status: subscription.status,
                        agreement_version: agreementVersion,
                        stripe_customer_id: customerId,
                      },
                    });

                    // Send Slack notification for new subscription
                    // Get subscription details for notification
                    const subItems = subscription.items?.data || [];
                    const firstItem = subItems[0];
                    let productName: string | undefined;
                    let amount: number | undefined;
                    let interval: string | undefined;

                    if (firstItem?.price) {
                      amount = firstItem.price.unit_amount || undefined;
                      interval = firstItem.price.recurring?.interval;
                      if (firstItem.price.product) {
                        try {
                          const product = await stripe.products.retrieve(firstItem.price.product as string);
                          productName = product.name;
                        } catch (e) {
                          // Ignore product fetch errors
                        }
                      }
                    }

                    notifyNewSubscription({
                      organizationName: org.name || 'Unknown Organization',
                      customerEmail: userEmail,
                      productName,
                      amount,
                      currency: subscription.currency,
                      interval,
                    }).catch(err => logger.error({ err }, 'Failed to send Slack notification'));

                    // Send thank you to org admin group DM (fire-and-forget)
                    (async () => {
                      try {
                        // Get org admins/owners
                        const orgMemberships = await workos!.userManagement.listOrganizationMemberships({
                          organizationId: org.workos_organization_id,
                        });
                        const adminEmails: string[] = [];
                        for (const membership of orgMemberships.data) {
                          if (membership.role?.slug === 'admin' || membership.role?.slug === 'owner') {
                            try {
                              const adminUser = await workos!.userManagement.getUser(membership.userId);
                              if (adminUser.email) {
                                adminEmails.push(adminUser.email);
                              }
                            } catch {
                              // Skip if can't fetch user
                            }
                          }
                        }

                        if (adminEmails.length > 0) {
                          await notifySubscriptionThankYou({
                            orgId: org.workos_organization_id,
                            orgName: org.name || 'Organization',
                            adminEmails,
                          });
                        }
                      } catch (err) {
                        logger.warn({ err, orgId: org.workos_organization_id }, 'Failed to send thank you to admin group DM');
                      }
                    })();

                    // Send welcome email to new member
                    sendWelcomeEmail({
                      to: userEmail,
                      organizationName: org.name || 'Unknown Organization',
                      productName,
                      workosUserId: workosUser.id,
                      workosOrganizationId: org.workos_organization_id,
                      isPersonal: org.is_personal || false,
                      firstName: workosUser.firstName || undefined,
                    }).catch(err => logger.error({ err }, 'Failed to send welcome email'));

                    // Record to org_activities for prospect tracking
                    const amountStr = amount ? `$${(amount / 100).toFixed(2)}` : '';
                    const intervalStr = interval ? `/${interval}` : '';
                    await pool.query(
                      `INSERT INTO org_activities (
                        organization_id,
                        activity_type,
                        description,
                        logged_by_user_id,
                        logged_by_name,
                        activity_date
                      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                      [
                        org.workos_organization_id,
                        'subscription',
                        `Subscribed to ${productName || 'membership'} ${amountStr}${intervalStr}`.trim(),
                        workosUser.id,
                        userEmail,
                      ]
                    );
                  } else {
                    logger.error({
                      userEmail,
                      customerId,
                      subscriptionId: subscription.id,
                      orgId: org.workos_organization_id,
                    }, 'Could not find WorkOS user for Stripe customer - subscription exists but no user found');
                  }
                } catch (userError) {
                  logger.error({
                    error: userError,
                    customerId,
                    subscriptionId: subscription.id,
                    orgId: org.workos_organization_id,
                  }, 'Failed to record agreement acceptance in webhook');
                }
              }
            }

            // Update database with subscription status, period end, and pricing details
            // This allows admin dashboard to display data without querying Stripe API
            try {
              const customerId = subscription.customer as string;
              const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              if (org) {
                // Calculate period end from subscription or invoice
                let periodEnd: Date | null = null;

                if ((subscription as any).current_period_end) {
                  periodEnd = new Date((subscription as any).current_period_end * 1000);
                }

                // Extract pricing details from subscription items
                const priceData = subscription.items?.data?.[0]?.price;
                const amount = priceData?.unit_amount ?? null;
                const currency = priceData?.currency ?? null;
                const interval = priceData?.recurring?.interval ?? null;

                await pool.query(
                  `UPDATE organizations
                   SET subscription_status = $1,
                       stripe_subscription_id = $2,
                       subscription_current_period_end = $3,
                       subscription_amount = COALESCE($4, subscription_amount),
                       subscription_currency = COALESCE($5, subscription_currency),
                       subscription_interval = COALESCE($6, subscription_interval),
                       updated_at = NOW()
                   WHERE workos_organization_id = $7`,
                  [
                    subscription.status,
                    subscription.id,
                    periodEnd,
                    amount,
                    currency,
                    interval,
                    org.workos_organization_id
                  ]
                );

                logger.info({
                  orgId: org.workos_organization_id,
                  subscriptionId: subscription.id,
                  status: subscription.status,
                  periodEnd: periodEnd?.toISOString(),
                  amount,
                  currency,
                  interval,
                }, 'Subscription data synced to database');

                // Invalidate member context cache for all users in this org
                // (subscription status affects is_member and subscription fields)
                invalidateMemberContextCache();

                // Send Slack notification for subscription cancellation
                if (event.type === 'customer.subscription.deleted') {
                  // Record audit log for subscription cancellation (use system user since webhook context)
                  await orgDb.recordAuditLog({
                    workos_organization_id: org.workos_organization_id,
                    workos_user_id: SYSTEM_USER_ID,
                    action: 'subscription_cancelled',
                    resource_type: 'subscription',
                    resource_id: subscription.id,
                    details: {
                      status: subscription.status,
                      stripe_customer_id: customerId,
                    },
                  });

                  notifySubscriptionCancelled({
                    organizationName: org.name || 'Unknown Organization',
                  }).catch(err => logger.error({ err }, 'Failed to send Slack cancellation notification'));

                  // Record to org_activities for prospect tracking
                  await pool.query(
                    `INSERT INTO org_activities (
                      organization_id,
                      activity_type,
                      description,
                      logged_by_user_id,
                      logged_by_name,
                      activity_date
                    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                    [
                      org.workos_organization_id,
                      'subscription_cancelled',
                      'Subscription cancelled',
                      SYSTEM_USER_ID,
                      'System',
                    ]
                  );
                }
              }
            } catch (syncError) {
              logger.error({ error: syncError }, 'Failed to sync subscription data to database');
              // Don't throw - let webhook succeed even if sync fails
            }
            break;
          }

          // Invoice lifecycle events - cache for prospects page (avoids Stripe API calls)
          case 'invoice.created':
          case 'invoice.updated':
          case 'invoice.finalized':
          case 'invoice.voided': {
            const invoice = event.data.object as Stripe.Invoice;
            logger.debug({
              invoiceId: invoice.id,
              status: invoice.status,
              eventType: event.type,
            }, 'Invoice lifecycle event');

            // Find org by customer ID
            const customerId = invoice.customer as string;
            const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

            // Get product name from line items if available
            let productName: string | null = null;
            if (invoice.lines?.data && invoice.lines.data.length > 0) {
              const primaryLine = invoice.lines.data[0] as any;
              const productId = primaryLine.price?.product as string;
              if (productId && stripe) {
                try {
                  const product = await stripe.products.retrieve(productId);
                  productName = product.name;
                } catch (err) {
                  logger.debug({ err, productId, invoiceId: invoice.id }, 'Failed to retrieve product name, using fallback');
                  productName = primaryLine.description || null;
                }
              }
            }

            await upsertInvoiceCache(
              pool,
              invoice,
              org?.workos_organization_id || null,
              productName
            );
            break;
          }

          case 'invoice.payment_succeeded':
          case 'invoice.paid': {
            const invoice = event.data.object as Stripe.Invoice;
            logger.info({
              customer: invoice.customer,
              invoiceId: invoice.id,
              amount: invoice.amount_paid,
              eventType: event.type,
            }, 'Invoice paid');

            // Get organization from customer ID
            const customerId = invoice.customer as string;

            // Try to find org by stripe_customer_id first
            let org = await orgDb.getOrganizationByStripeCustomerId(customerId);

            // If not found, look up by workos_organization_id in Stripe customer metadata
            if (!org) {
              logger.info({ customerId, invoiceId: invoice.id }, 'Org not found by customer ID, checking Stripe metadata');
              const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
              const workosOrgId = customer.metadata?.workos_organization_id;

              if (workosOrgId) {
                org = await orgDb.getOrganization(workosOrgId);
                if (org) {
                  // Link the Stripe customer ID to the organization
                  await orgDb.setStripeCustomerId(workosOrgId, customerId);
                  logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization from invoice webhook');
                }
              }
            }

            if (!org) {
              logger.warn({
                customerId,
                invoiceId: invoice.id,
                amount: invoice.amount_paid,
              }, 'Invoice payment received but no organization found for Stripe customer');
            } else if (invoice.amount_paid === 0) {
              logger.debug({
                customerId,
                invoiceId: invoice.id,
              }, 'Skipping zero-amount invoice');
            }

            if (org && invoice.amount_paid > 0) {
              // Determine revenue type
              let revenueType = 'one_time';
              if ((invoice as any).subscription) {
                revenueType = invoice.billing_reason === 'subscription_create'
                  ? 'subscription_initial'
                  : 'subscription_recurring';
              }

              // Extract primary product details (first line item)
              let productId: string | null = null;
              let productName: string | null = null;
              let priceId: string | null = null;
              let billingInterval: string | null = null;

              if (invoice.lines?.data && invoice.lines.data.length > 0) {
                const primaryLine = invoice.lines.data[0] as any;
                productId = primaryLine.price?.product as string || null;
                priceId = primaryLine.price?.id || null;
                billingInterval = primaryLine.price?.recurring?.interval || null;

                // Fetch product name if we have product ID
                if (productId) {
                  try {
                    const product = await stripe.products.retrieve(productId);
                    productName = product.name;
                  } catch (err) {
                    logger.error({ err, productId }, 'Failed to retrieve product details');
                    // Fallback to line item description (useful for tests)
                    productName = primaryLine.description || null;
                  }
                }
              }

              // Record revenue event
              try {
                await pool.query(
                  `INSERT INTO revenue_events (
                    workos_organization_id,
                    stripe_invoice_id,
                    stripe_subscription_id,
                    stripe_payment_intent_id,
                    stripe_charge_id,
                    amount_paid,
                    currency,
                    revenue_type,
                    billing_reason,
                    product_id,
                    product_name,
                    price_id,
                    billing_interval,
                    paid_at,
                    period_start,
                    period_end,
                    metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
                  [
                    org.workos_organization_id,
                    invoice.id,
                    (invoice as any).subscription || null,
                    (invoice as any).payment_intent || null,
                    (invoice as any).charge || null,
                    invoice.amount_paid, // in cents
                    invoice.currency,
                    revenueType,
                    invoice.billing_reason || null,
                    productId,
                    productName,
                    priceId,
                    billingInterval,
                    new Date(invoice.status_transitions.paid_at! * 1000),
                    invoice.period_start ? new Date(invoice.period_start * 1000) : null,
                    invoice.period_end ? new Date(invoice.period_end * 1000) : null,
                    JSON.stringify({
                      invoice_number: invoice.number,
                      hosted_invoice_url: invoice.hosted_invoice_url,
                      invoice_pdf: invoice.invoice_pdf,
                      metadata: invoice.metadata,
                    }),
                  ]
                );
              } catch (revenueError) {
                logger.error({
                  err: revenueError,
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed to insert revenue event');
                // Continue processing - don't fail the webhook
              }

              // Store subscription line items for subscriptions
              if (invoice.subscription && invoice.lines?.data) {
                const subscriptionId = invoice.subscription as string;

                for (const line of invoice.lines.data) {
                  if (line.type === 'subscription') {
                    const lineProductId = line.price?.product as string || null;
                    let lineProductName: string | null = null;

                    // Fetch product name
                    if (lineProductId) {
                      try {
                        const product = await stripe.products.retrieve(lineProductId);
                        lineProductName = product.name;
                      } catch (err) {
                        logger.error({ err, productId: lineProductId }, 'Failed to retrieve line product');
                        // Fallback to line item description (useful for tests)
                        lineProductName = line.description || null;
                      }
                    }

                    // Upsert line item (update if exists, insert if new)
                    await pool.query(
                      `INSERT INTO subscription_line_items (
                        workos_organization_id,
                        stripe_subscription_id,
                        stripe_subscription_item_id,
                        price_id,
                        product_id,
                        product_name,
                        quantity,
                        amount,
                        billing_interval,
                        usage_type,
                        metadata
                      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                      ON CONFLICT (stripe_subscription_item_id)
                      DO UPDATE SET
                        price_id = EXCLUDED.price_id,
                        product_id = EXCLUDED.product_id,
                        product_name = EXCLUDED.product_name,
                        quantity = EXCLUDED.quantity,
                        amount = EXCLUDED.amount,
                        billing_interval = EXCLUDED.billing_interval,
                        usage_type = EXCLUDED.usage_type,
                        metadata = EXCLUDED.metadata,
                        updated_at = NOW()`,
                      [
                        org.workos_organization_id,
                        subscriptionId,
                        line.subscription_item || null,
                        line.price?.id || null,
                        lineProductId,
                        lineProductName,
                        line.quantity || 1,
                        line.amount, // in cents
                        line.price?.recurring?.interval || null,
                        line.price?.recurring?.usage_type || 'licensed',
                        JSON.stringify(line.metadata || {}),
                      ]
                    );
                  }
                }
              }

              // Update organization subscription details cache
              if (invoice.subscription) {
                await pool.query(
                  `UPDATE organizations
                   SET subscription_product_id = $1,
                       subscription_product_name = $2,
                       subscription_price_id = $3,
                       subscription_amount = $4,
                       subscription_currency = $5,
                       subscription_interval = $6,
                       subscription_metadata = $7,
                       updated_at = NOW()
                   WHERE workos_organization_id = $8`,
                  [
                    productId,
                    productName,
                    priceId,
                    invoice.amount_paid,
                    invoice.currency,
                    billingInterval,
                    JSON.stringify(invoice.metadata || {}),
                    org.workos_organization_id,
                  ]
                );
              }

              logger.info({
                orgId: org.workos_organization_id,
                invoiceId: invoice.id,
                amount: invoice.amount_paid,
                revenueType,
                productName,
              }, 'Revenue event recorded');

              // Send Slack notification for payment
              notifyPaymentSucceeded({
                organizationName: org.name || 'Unknown Organization',
                amount: invoice.amount_paid,
                currency: invoice.currency,
                productName: productName || undefined,
                isRecurring: revenueType === 'subscription_recurring',
              }).catch(err => logger.error({ err }, 'Failed to send Slack payment notification'));

              // Record to org_activities for prospect tracking (for recurring payments)
              if (revenueType === 'subscription_recurring') {
                const amountFormatted = `$${(invoice.amount_paid / 100).toFixed(2)}`;
                await pool.query(
                  `INSERT INTO org_activities (
                    organization_id,
                    activity_type,
                    description,
                    logged_by_user_id,
                    logged_by_name,
                    activity_date
                  ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                  [
                    org.workos_organization_id,
                    'payment',
                    `Renewal payment ${amountFormatted} for ${productName || 'membership'}`,
                    SYSTEM_USER_ID,
                    'System',
                  ]
                );
              }
            }

            // Update invoice cache (for prospects page - avoids Stripe API calls)
            // Get product name for cache even if we didn't process revenue above
            let cachedProductName: string | null = null;
            if (invoice.lines?.data && invoice.lines.data.length > 0) {
              const primaryLine = invoice.lines.data[0] as any;
              const cachedProductId = primaryLine.price?.product as string;
              if (cachedProductId && stripe) {
                try {
                  const product = await stripe.products.retrieve(cachedProductId);
                  cachedProductName = product.name;
                } catch (err) {
                  logger.debug({ err, productId: cachedProductId, invoiceId: invoice.id }, 'Failed to retrieve product name for cache, using fallback');
                  cachedProductName = primaryLine.description || null;
                }
              }
            }
            await upsertInvoiceCache(
              pool,
              invoice,
              org?.workos_organization_id || null,
              cachedProductName
            );
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            logger.warn({
              customer: invoice.customer,
              invoiceId: invoice.id,
              attemptCount: invoice.attempt_count,
            }, 'Invoice payment failed');

            // Get organization from customer ID
            const customerId = invoice.customer as string;
            const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

            if (org) {
              // Record failed payment event
              try {
                await pool.query(
                  `INSERT INTO revenue_events (
                    workos_organization_id,
                    stripe_invoice_id,
                    stripe_subscription_id,
                    stripe_payment_intent_id,
                    amount_paid,
                    currency,
                    revenue_type,
                    billing_reason,
                    paid_at,
                    metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [
                    org.workos_organization_id,
                    invoice.id,
                    invoice.subscription || null,
                    invoice.payment_intent || null,
                    0, // No payment received
                    invoice.currency,
                    'payment_failed',
                    invoice.billing_reason || null,
                    new Date(),
                    JSON.stringify({
                      attempt_count: invoice.attempt_count,
                      next_payment_attempt: invoice.next_payment_attempt,
                      last_finalization_error: invoice.last_finalization_error,
                      metadata: invoice.metadata,
                    }),
                  ]
                );

                logger.info({
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed payment event recorded');
              } catch (revenueError) {
                logger.error({
                  err: revenueError,
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed to insert failed payment event');
                // Continue processing - don't fail the webhook
              }

              // Send Slack notification for failed payment
              notifyPaymentFailed({
                organizationName: org.name || 'Unknown Organization',
                amount: invoice.amount_due,
                currency: invoice.currency,
                attemptCount: invoice.attempt_count || 1,
              }).catch(err => logger.error({ err }, 'Failed to send Slack failed payment notification'));
            }

            // Update invoice cache (keeps status in sync for prospects page)
            await upsertInvoiceCache(
              pool,
              invoice,
              org?.workos_organization_id || null,
              null
            );
            break;
          }

          case 'charge.refunded': {
            const charge = event.data.object as Stripe.Charge;
            logger.info({
              chargeId: charge.id,
              amountRefunded: charge.amount_refunded,
            }, 'Charge refunded');

            // Get organization from customer ID
            if (charge.customer) {
              const customerId = charge.customer as string;
              const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              if (org && charge.amount_refunded > 0) {
                // Record refund as negative revenue event
                try {
                  await pool.query(
                    `INSERT INTO revenue_events (
                      workos_organization_id,
                      stripe_charge_id,
                      stripe_payment_intent_id,
                      amount_paid,
                      currency,
                      revenue_type,
                      paid_at,
                      metadata
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                      org.workos_organization_id,
                      charge.id,
                      charge.payment_intent || null,
                      -charge.amount_refunded, // Negative amount for refund
                      charge.currency,
                      'refund',
                      new Date(),
                      JSON.stringify({
                        refund_reason: charge.refunds?.data[0]?.reason || null,
                        original_charge_amount: charge.amount,
                        refunded_amount: charge.amount_refunded,
                        metadata: charge.metadata,
                      }),
                    ]
                  );

                  logger.info({
                    orgId: org.workos_organization_id,
                    chargeId: charge.id,
                    refundAmount: charge.amount_refunded,
                  }, 'Refund event recorded');
                } catch (revenueError) {
                  logger.error({
                    err: revenueError,
                    orgId: org.workos_organization_id,
                    chargeId: charge.id,
                  }, 'Failed to insert refund event');
                  // Continue processing - don't fail the webhook
                }
              }
            }
            break;
          }

          default:
            logger.debug({ eventType: event.type }, 'Unhandled webhook event type');
        }

        res.json({ received: true });
      } catch (error) {
        logger.error({ err: error }, 'Error processing webhook');
        res.status(500).json({ error: 'Webhook processing failed' });
      }
    });

    // Admin routes
    // GET /admin - Admin landing page
    this.app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin.html');
    });


    // GET /api/admin/audit-logs - Get audit log entries
    this.app.get('/api/admin/audit-logs', requireAuth, requireAdmin, async (req, res) => {
      try {
        const {
          organization_id,
          action,
          resource_type,
          limit = '50',
          offset = '0',
        } = req.query;

        const auditOrgDb = new OrganizationDatabase();
        const result = await auditOrgDb.getAuditLogs({
          workos_organization_id: organization_id as string | undefined,
          action: action as string | undefined,
          resource_type: resource_type as string | undefined,
          limit: parseInt(limit as string, 10),
          offset: parseInt(offset as string, 10),
        });

        // Enrich with organization and user names (with caching to reduce API calls)
        const enrichedEntries = await Promise.all(
          result.entries.map(async (entry) => {
            let organizationName = 'Unknown';
            let userName = 'Unknown';

            // Check cache first for organization
            const cachedOrg = getCachedOrg(entry.workos_organization_id);
            if (cachedOrg) {
              organizationName = cachedOrg.name;
            } else {
              try {
                const org = await workos!.organizations.getOrganization(entry.workos_organization_id);
                organizationName = org.name;
                setCachedOrg(entry.workos_organization_id, org.name);
              } catch (err) {
                logger.warn({ err, orgId: entry.workos_organization_id }, 'Failed to fetch organization name for audit log');
              }
            }

            if (entry.workos_user_id !== SYSTEM_USER_ID) {
              // Check cache first for user
              const cachedUser = getCachedUser(entry.workos_user_id);
              if (cachedUser) {
                userName = cachedUser.displayName;
              } else {
                try {
                  const user = await workos!.userManagement.getUser(entry.workos_user_id);
                  const displayName = user.email || `${user.firstName} ${user.lastName}`.trim() || 'Unknown';
                  userName = displayName;
                  setCachedUser(entry.workos_user_id, displayName);
                } catch (err) {
                  logger.warn({ err, userId: entry.workos_user_id }, 'Failed to fetch user name for audit log');
                }
              }
            } else {
              userName = 'System';
            }

            return {
              ...entry,
              organization_name: organizationName,
              user_name: userName,
            };
          })
        );

        res.json({
          entries: enrichedEntries,
          total: result.total,
          limit: parseInt(limit as string, 10),
          offset: parseInt(offset as string, 10),
        });
      } catch (error) {
        logger.error({ err: error }, 'Get audit logs error:');
        res.status(500).json({
          error: 'Failed to get audit logs',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Admin agreement management endpoints
    // GET /api/admin/agreements - List all agreements
    this.app.get('/api/admin/agreements', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        const result = await pool.query(
          'SELECT * FROM agreements ORDER BY agreement_type, effective_date DESC'
        );

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error }, 'Get all agreements error:');
        res.status(500).json({
          error: 'Failed to get agreements',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/admin/agreements - Create new agreement
    this.app.post('/api/admin/agreements', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { agreement_type, version, effective_date, text } = req.body;
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];

        if (!agreement_type || !version || !effective_date || !text) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type, version, effective_date, and text are required'
          });
        }

        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy'
          });
        }

        const pool = getPool();
        const result = await pool.query(
          `INSERT INTO agreements (agreement_type, version, effective_date, text)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [agreement_type, version, effective_date, text]
        );

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, 'Create agreement error:');
        res.status(500).json({
          error: 'Failed to create agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/admin/agreements/:id - Update agreement
    this.app.put('/api/admin/agreements/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { agreement_type, version, effective_date, text } = req.body;
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];

        if (!agreement_type || !version || !effective_date || !text) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type, version, effective_date, and text are required'
          });
        }

        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy'
          });
        }

        const pool = getPool();
        const result = await pool.query(
          `UPDATE agreements
           SET agreement_type = $1, version = $2, effective_date = $3, text = $4
           WHERE id = $5
           RETURNING *`,
          [agreement_type, version, effective_date, text, id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: `No agreement found with id ${id}`
          });
        }

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, 'Update agreement error:');
        res.status(500).json({
          error: 'Failed to update agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/admin/agreements/record - Admin endpoint to record missing agreement acceptances
    // Used to fix organizations where agreement wasn't properly recorded during subscription
    this.app.post('/api/admin/agreements/record', requireAuth, requireAdmin, async (req, res) => {
      const { workos_user_id, email, agreement_type, agreement_version, workos_organization_id } = req.body;

      if (!workos_user_id || !email || !agreement_type) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'workos_user_id, email, and agreement_type are required',
        });
      }

      const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];
      if (!validTypes.includes(agreement_type)) {
        return res.status(400).json({
          error: 'Invalid agreement type',
          message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy',
        });
      }

      const orgDb = new OrganizationDatabase();

      try {
        // Get current agreement version if not provided
        let version = agreement_version;
        if (!version) {
          const currentAgreement = await orgDb.getCurrentAgreementByType(agreement_type);
          if (!currentAgreement) {
            return res.status(400).json({
              error: 'No agreement found',
              message: `No ${agreement_type} agreement exists in the system`,
            });
          }
          version = currentAgreement.version;
        }

        // Record the acceptance
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id,
          email,
          agreement_type,
          agreement_version: version,
          workos_organization_id: workos_organization_id || null,
          ip_address: 'admin-recorded',
          user_agent: `Admin: ${req.user!.email}`,
        });

        logger.info({
          workos_user_id,
          email,
          agreement_type,
          agreement_version: version,
          recorded_by: req.user!.email,
        }, 'Admin recorded agreement acceptance');

        res.json({
          success: true,
          recorded: {
            workos_user_id,
            email,
            agreement_type,
            agreement_version: version,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Admin record agreement error');
        res.status(500).json({
          error: 'Failed to record agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/admin/analytics-data - Get simple analytics data from views
    this.app.get('/api/admin/analytics-data', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        // Query all analytics views
        const [revenueByMonth, customerHealth, subscriptionMetrics, productRevenue, totalRevenue, totalCustomers] = await Promise.all([
          pool.query('SELECT * FROM revenue_by_month ORDER BY month DESC LIMIT 12'),
          pool.query('SELECT * FROM customer_health ORDER BY customer_since DESC'),
          pool.query('SELECT * FROM subscription_metrics LIMIT 1'),
          pool.query('SELECT * FROM product_revenue ORDER BY total_revenue DESC'),
          pool.query('SELECT SUM(net_revenue) as total FROM revenue_by_month'),
          pool.query('SELECT COUNT(*) as total FROM customer_health'),
        ]);

        const metrics = subscriptionMetrics.rows[0] || {};
        res.json({
          revenue_by_month: revenueByMonth.rows,
          customer_health: customerHealth.rows,
          subscription_metrics: {
            ...metrics,
            mrr: metrics.total_mrr || 0,
            total_revenue: totalRevenue.rows[0]?.total || 0,
            total_customers: totalCustomers.rows[0]?.total || 0,
          },
          product_revenue: productRevenue.rows,
        });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching analytics data');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch analytics data',
        });
      }
    });

    // POST /api/admin/backfill-revenue - Backfill revenue data from Stripe
    this.app.post('/api/admin/backfill-revenue', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        const orgDb = new OrganizationDatabase();

        // Build map of Stripe customer IDs to WorkOS organization IDs
        // First, get all orgs that already have stripe_customer_id linked
        const orgsResult = await pool.query(`
          SELECT stripe_customer_id, workos_organization_id
          FROM organizations
          WHERE stripe_customer_id IS NOT NULL
        `);

        const customerOrgMap = new Map<string, string>();
        for (const row of orgsResult.rows) {
          customerOrgMap.set(row.stripe_customer_id, row.workos_organization_id);
        }

        // Also fetch all Stripe customers and link any that have workos_organization_id in metadata
        if (stripe) {
          let customersLinked = 0;
          for await (const customer of stripe.customers.list({ limit: 100 })) {
            // Skip if already in map
            if (customerOrgMap.has(customer.id)) continue;

            const workosOrgId = customer.metadata?.workos_organization_id;
            if (workosOrgId) {
              // Verify org exists
              const org = await orgDb.getOrganization(workosOrgId);
              if (org) {
                customerOrgMap.set(customer.id, workosOrgId);
                // Link the customer ID to the org in our DB
                await orgDb.setStripeCustomerId(workosOrgId, customer.id);
                customersLinked++;
                logger.info({ customerId: customer.id, workosOrgId }, 'Linked Stripe customer during backfill');
              }
            }
          }
          if (customersLinked > 0) {
            logger.info({ customersLinked }, 'Linked additional customers from Stripe metadata');
          }
        }

        if (customerOrgMap.size === 0) {
          return res.json({
            success: true,
            message: 'No organizations with Stripe customers found. Link customers to orgs first.',
            invoices_found: 0,
            refunds_found: 0,
            processed: 0,
            subscriptions_synced: 0,
            subscriptions_failed: 0,
          });
        }

        // Fetch all revenue events from Stripe
        const [invoices, refunds] = await Promise.all([
          fetchAllPaidInvoices(customerOrgMap),
          fetchAllRefunds(customerOrgMap),
        ]);

        const allEvents = [...invoices, ...refunds];

        // Import events, updating existing records with fresh data from Stripe
        let imported = 0;

        for (const event of allEvents) {
          await pool.query(
            `INSERT INTO revenue_events (
              workos_organization_id,
              stripe_invoice_id,
              stripe_subscription_id,
              stripe_payment_intent_id,
              stripe_charge_id,
              amount_paid,
              currency,
              revenue_type,
              billing_reason,
              product_id,
              product_name,
              price_id,
              billing_interval,
              paid_at,
              period_start,
              period_end
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            ON CONFLICT (stripe_invoice_id) DO UPDATE SET
              workos_organization_id = EXCLUDED.workos_organization_id,
              stripe_subscription_id = EXCLUDED.stripe_subscription_id,
              stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
              stripe_charge_id = EXCLUDED.stripe_charge_id,
              amount_paid = EXCLUDED.amount_paid,
              currency = EXCLUDED.currency,
              revenue_type = EXCLUDED.revenue_type,
              billing_reason = EXCLUDED.billing_reason,
              product_id = EXCLUDED.product_id,
              product_name = EXCLUDED.product_name,
              price_id = EXCLUDED.price_id,
              billing_interval = EXCLUDED.billing_interval,
              paid_at = EXCLUDED.paid_at,
              period_start = EXCLUDED.period_start,
              period_end = EXCLUDED.period_end`,
            [
              event.workos_organization_id,
              event.stripe_invoice_id,
              event.stripe_subscription_id,
              event.stripe_payment_intent_id,
              event.stripe_charge_id,
              event.amount_paid,
              event.currency,
              event.revenue_type,
              event.billing_reason,
              event.product_id,
              event.product_name,
              event.price_id,
              event.billing_interval,
              event.paid_at,
              event.period_start,
              event.period_end,
            ]
          );
          imported++;
        }

        // Sync subscription data to organizations for MRR calculation
        // This populates subscription_amount, subscription_interval, subscription_current_period_end
        let subscriptionsSynced = 0;
        let subscriptionsFailed = 0;
        if (stripe) {
          for (const [customerId, workosOrgId] of customerOrgMap) {
            try {
              // Get customer with subscriptions and expanded price/product data in single API call
              const customer = await stripe.customers.retrieve(customerId, {
                expand: ['subscriptions.data.items.data.price.product'],
              });

              if ('deleted' in customer && customer.deleted) {
                continue;
              }

              const subscriptions = (customer as Stripe.Customer).subscriptions;
              if (!subscriptions || subscriptions.data.length === 0) {
                continue;
              }

              // Get the first active subscription (already has expanded items)
              const subscription = subscriptions.data[0];
              if (!subscription || !['active', 'trialing', 'past_due'].includes(subscription.status)) {
                continue;
              }

              // Get primary subscription item directly from expanded data
              const primaryItem = subscription.items.data[0];
              if (!primaryItem) {
                continue;
              }

              const price = primaryItem.price;
              const product = price?.product as Stripe.Product | undefined;
              const amount = price?.unit_amount ?? 0;
              const interval = price?.recurring?.interval ?? null;

              // Update organization with subscription details
              await pool.query(
                `UPDATE organizations
                 SET subscription_status = $1,
                     subscription_amount = $2,
                     subscription_interval = $3,
                     subscription_currency = $4,
                     subscription_current_period_end = $5,
                     subscription_canceled_at = $6,
                     subscription_product_id = $7,
                     subscription_product_name = $8,
                     subscription_price_id = $9,
                     updated_at = NOW()
                 WHERE workos_organization_id = $10`,
                [
                  subscription.status,
                  amount,
                  interval,
                  price?.currency || 'usd',
                  subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
                  subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
                  product?.id || null,
                  product?.name || null,
                  price?.id || null,
                  workosOrgId,
                ]
              );

              subscriptionsSynced++;
              logger.debug({ workosOrgId, customerId, amount, interval }, 'Synced subscription data');
            } catch (subError) {
              subscriptionsFailed++;
              logger.error({ err: subError, customerId, workosOrgId }, 'Failed to sync subscription for customer');
              // Continue with other customers
            }
          }
        }

        logger.info({
          invoices: invoices.length,
          refunds: refunds.length,
          processed: imported,
          subscriptionsSynced,
          subscriptionsFailed,
        }, 'Revenue backfill completed');

        res.json({
          success: true,
          message: `Sync completed: ${imported} records processed`,
          invoices_found: invoices.length,
          refunds_found: refunds.length,
          processed: imported,
          subscriptions_synced: subscriptionsSynced,
          subscriptions_failed: subscriptionsFailed,
        });
      } catch (error) {
        logger.error({ err: error }, 'Error during revenue backfill');
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Revenue backfill failed',
        });
      }
    });

    // ========================================
    // Committee Routes (Working Groups, Councils, Chapters)
    // ========================================

    const { adminApiRouter, publicApiRouter, userApiRouter } = createCommitteeRouters();
    this.app.use('/api/admin/working-groups', adminApiRouter);
    this.app.use('/api/working-groups', publicApiRouter);
    this.app.use('/api/me/working-groups', userApiRouter);

    // ========================================
    // SEO Routes (sitemap.xml, robots.txt)
    // ========================================

    // GET /sitemap.xml - Dynamic sitemap including all published perspectives
    this.app.get('/sitemap.xml', async (req, res) => {
      try {
        const baseUrl = 'https://agenticadvertising.org';
        const pool = getPool();

        // Get all published perspectives
        const perspectivesResult = await pool.query(
          `SELECT slug, updated_at, published_at
           FROM perspectives
           WHERE status = 'published'
           ORDER BY published_at DESC`
        );

        // Static pages with their priorities and change frequencies
        const staticPages = [
          { path: '/', priority: '1.0', changefreq: 'weekly' },
          { path: '/perspectives', priority: '0.9', changefreq: 'daily' },
          { path: '/working-groups', priority: '0.8', changefreq: 'weekly' },
          { path: '/members', priority: '0.8', changefreq: 'weekly' },
          { path: '/join', priority: '0.7', changefreq: 'monthly' },
        ];

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

        // Add static pages
        for (const page of staticPages) {
          xml += `  <url>
    <loc>${baseUrl}${page.path}</loc>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>
`;
        }

        // Add perspectives
        for (const perspective of perspectivesResult.rows) {
          const lastmod = perspective.updated_at || perspective.published_at;
          xml += `  <url>
    <loc>${baseUrl}/perspectives/${perspective.slug}</loc>
    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
`;
        }

        xml += `</urlset>`;

        res.set('Content-Type', 'application/xml');
        res.send(xml);
      } catch (error) {
        logger.error({ err: error }, 'Generate sitemap error:');
        res.status(500).send('Error generating sitemap');
      }
    });

    // GET /robots.txt - Robots file with sitemap reference
    this.app.get('/robots.txt', (req, res) => {
      const baseUrl = 'https://agenticadvertising.org';
      const robotsTxt = `# AgenticAdvertising.org Robots.txt
User-agent: *
Allow: /

# Sitemaps
Sitemap: ${baseUrl}/sitemap.xml

# Disallow admin pages
Disallow: /admin/
Disallow: /auth/
Disallow: /api/admin/
`;
      res.set('Content-Type', 'text/plain');
      res.send(robotsTxt);
    });

    // Serve admin pages
    // Note: /admin/prospects route is now in routes/admin.ts

    this.app.get('/admin/members', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-members.html');
    });

    this.app.get('/admin/agreements', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-agreements.html');
    });

    this.app.get('/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-analytics.html');
    });

    this.app.get('/admin/audit', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-audit.html');
    });

    // Note: /admin/billing is now served from billing.ts router

    this.app.get('/admin/perspectives', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-perspectives.html');
    });

    this.app.get('/admin/working-groups', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-working-groups.html');
    });

    this.app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-users.html');
    });

    this.app.get('/admin/email', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-email.html');
    });

    this.app.get('/admin/feeds', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-feeds.html');
    });

    this.app.get('/admin/notification-channels', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-notification-channels.html');
    });

    this.app.get('/admin/settings', requireAuth, requireAdmin, async (req, res) => {
      await this.serveHtmlWithConfig(req, res, 'admin-settings.html');
    });

    // Registry API endpoints (consolidated agents, publishers, lookups)
    this.setupRegistryRoutes();
  }

  /**
   * Setup registry API endpoints
   * Consolidated endpoints for agents, publishers, and lookups
   * These are the canonical endpoints - old /api/federated/* routes redirect here
   */
  private setupRegistryRoutes(): void {
    const federatedIndex = this.crawler.getFederatedIndex();

    // ========================================
    // Registry Agents API
    // ========================================

    // GET /api/registry/agents - List all agents (registered + discovered)
    // Supports enrichment via query params: health, capabilities, properties
    this.app.get("/api/registry/agents", async (req, res) => {
      try {
        const type = req.query.type as AgentType | undefined;
        const withHealth = req.query.health === "true";
        const withCapabilities = req.query.capabilities === "true";
        const withProperties = req.query.properties === "true";

        // Get agents from federated index (includes both registered and discovered)
        const federatedAgents = await federatedIndex.listAllAgents(type);

        // Convert FederatedAgent to Agent format for enrichment
        const agents = federatedAgents.map(fa => ({
          name: fa.name || fa.url,
          url: fa.url,
          type: isValidAgentType(fa.type) ? fa.type : 'unknown',
          protocol: fa.protocol || 'mcp',
          description: fa.member?.display_name || fa.discovered_from?.publisher_domain || '',
          mcp_endpoint: fa.url,
          contact: {
            name: fa.member?.display_name || '',
            email: '',
            website: '',
          },
          added_date: fa.discovered_at || new Date().toISOString().split('T')[0],
          // Preserve federated metadata
          source: fa.source,
          member: fa.member,
          discovered_from: fa.discovered_from,
        }));

        const bySource = {
          registered: federatedAgents.filter(a => a.source === 'registered').length,
          discovered: federatedAgents.filter(a => a.source === 'discovered').length,
        };

        // If no enrichment requested, return basic list
        if (!withHealth && !withCapabilities && !withProperties) {
          return res.json({
            agents,
            count: agents.length,
            sources: bySource,
          });
        }

        // Enrich with health, capabilities, and/or properties
        const enriched = await Promise.all(
          agents.map(async (agent): Promise<AgentWithStats> => {
            const promises = [];

            if (withHealth) {
              promises.push(
                this.healthChecker.checkHealth(agent as Agent),
                this.healthChecker.getStats(agent as Agent)
              );
            }

            if (withCapabilities) {
              promises.push(
                this.capabilityDiscovery.discoverCapabilities(agent as Agent)
              );
            }

            // For properties, query from database (populated by crawler)
            if (withProperties && agent.type === "sales") {
              promises.push(
                federatedIndex.getPropertiesForAgent(agent.url),
                federatedIndex.getPublisherDomainsForAgent(agent.url)
              );
            }

            const results = await Promise.all(promises);

            const enrichedAgent: AgentWithStats = { ...agent } as AgentWithStats;
            let resultIndex = 0;

            if (withHealth) {
              enrichedAgent.health = results[resultIndex++] as any;
              enrichedAgent.stats = results[resultIndex++] as any;
            }

            if (withCapabilities) {
              const capProfile = results[resultIndex++] as any;
              if (capProfile) {
                enrichedAgent.capabilities = {
                  tools_count: capProfile.discovered_tools?.length || 0,
                  tools: capProfile.discovered_tools || [],
                  standard_operations: capProfile.standard_operations,
                  creative_capabilities: capProfile.creative_capabilities,
                  signals_capabilities: capProfile.signals_capabilities,
                };
              }
            }

            if (withProperties && agent.type === "sales") {
              const properties = results[resultIndex++] as any[];
              const publisherDomains = results[resultIndex++] as string[];

              if (properties && properties.length > 0) {
                // Return summary counts instead of full property list (can be millions)
                // Full property details available via /api/registry/agents/:id/properties
                enrichedAgent.publisher_domains = publisherDomains;

                // Count properties by type (channel)
                const countByType: Record<string, number> = {};
                for (const prop of properties) {
                  const type = prop.property_type || 'unknown';
                  countByType[type] = (countByType[type] || 0) + 1;
                }

                // Collect all unique tags across properties
                const allTags = new Set<string>();
                for (const prop of properties) {
                  for (const tag of prop.tags || []) {
                    allTags.add(tag);
                  }
                }

                // Property summary instead of full list
                enrichedAgent.property_summary = {
                  total_count: properties.length,
                  count_by_type: countByType,
                  tags: Array.from(allTags),
                  publisher_count: publisherDomains.length,
                };
              }
            }

            return enrichedAgent;
          })
        );

        res.json({
          agents: enriched,
          count: enriched.length,
          sources: bySource,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to list agents",
        });
      }
    });

    // ========================================
    // Registry Publishers API
    // ========================================

    // GET /api/registry/publishers - List all publishers (registered + discovered)
    this.app.get("/api/registry/publishers", async (req, res) => {
      try {
        const publishers = await federatedIndex.listAllPublishers();
        const bySource = {
          registered: publishers.filter(p => p.source === 'registered').length,
          discovered: publishers.filter(p => p.source === 'discovered').length,
        };
        res.json({
          publishers,
          count: publishers.length,
          sources: bySource,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to list publishers",
        });
      }
    });

    // ========================================
    // Registry Lookup API
    // ========================================

    // GET /api/registry/lookup/property - Find agents for a property
    this.app.get("/api/registry/lookup/property", async (req, res) => {
      const { type, value } = req.query;

      if (!type || !value) {
        return res.status(400).json({
          error: "Missing required query params: type and value",
        });
      }

      try {
        // Query database for agents with matching property identifier
        const results = await federatedIndex.findAgentsForPropertyIdentifier(
          type as string,
          value as string
        );

        res.json({
          type,
          value,
          agents: results,
          count: results.length,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Property lookup failed",
        });
      }
    });

    // GET /api/registry/lookup/domain/:domain - Find agents authorized for a domain
    this.app.get("/api/registry/lookup/domain/:domain", async (req, res) => {
      try {
        const domain = req.params.domain;
        const result = await federatedIndex.lookupDomain(domain);
        res.json(result);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Domain lookup failed",
        });
      }
    });

    // GET /api/registry/lookup/agent/:agentUrl/domains - Get domains for an agent
    this.app.get("/api/registry/lookup/agent/:agentUrl/domains", async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.agentUrl);
        const domains = await federatedIndex.getDomainsForAgent(agentUrl);
        res.json({
          agent_url: agentUrl,
          domains,
          count: domains.length,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Agent domain lookup failed",
        });
      }
    });

    // ========================================
    // Registry Validation API
    // ========================================

    // POST /api/registry/validate/product-authorization
    // Validate agent authorization against a product's publisher_properties
    // Accepts same format as Product.publisher_properties from get_products
    // Use case: "Does agent X have rights to sell this product?"
    this.app.post("/api/registry/validate/product-authorization", async (req, res) => {
      try {
        const { agent_url, publisher_properties } = req.body;

        if (!agent_url) {
          return res.status(400).json({
            error: "Missing required field: agent_url",
          });
        }

        if (!publisher_properties || !Array.isArray(publisher_properties)) {
          return res.status(400).json({
            error: "Missing required field: publisher_properties (array of selectors)",
          });
        }

        const result = await federatedIndex.validateAgentForProduct(agent_url, publisher_properties);

        res.json({
          agent_url,
          ...result,
          checked_at: new Date().toISOString(),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Product authorization validation failed",
        });
      }
    });

    // POST /api/registry/expand/product-identifiers
    // Expand publisher_properties selectors to concrete property identifiers
    // Use case: Real-time system needs to cache all valid identifiers for a product
    this.app.post("/api/registry/expand/product-identifiers", async (req, res) => {
      try {
        const { agent_url, publisher_properties } = req.body;

        if (!agent_url) {
          return res.status(400).json({
            error: "Missing required field: agent_url",
          });
        }

        if (!publisher_properties || !Array.isArray(publisher_properties)) {
          return res.status(400).json({
            error: "Missing required field: publisher_properties (array of selectors)",
          });
        }

        const properties = await federatedIndex.expandPublisherPropertiesToIdentifiers(agent_url, publisher_properties);

        // Flatten all identifiers for easy caching
        const allIdentifiers: Array<{ type: string; value: string; property_id: string; publisher_domain: string }> = [];
        for (const prop of properties) {
          for (const identifier of prop.identifiers) {
            allIdentifiers.push({
              type: identifier.type,
              value: identifier.value,
              property_id: prop.property_id,
              publisher_domain: prop.publisher_domain,
            });
          }
        }

        res.json({
          agent_url,
          properties,
          identifiers: allIdentifiers,
          property_count: properties.length,
          identifier_count: allIdentifiers.length,
          generated_at: new Date().toISOString(),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Property expansion failed",
        });
      }
    });

    // GET /api/registry/validate/property-authorization
    // Quick check if a property identifier is authorized for an agent
    // Optimized for real-time ad request validation
    // Use case: "Is www.mytimes.com authorized for this agent?"
    this.app.get("/api/registry/validate/property-authorization", async (req, res) => {
      try {
        const { agent_url, identifier_type, identifier_value } = req.query;

        if (!agent_url || !identifier_type || !identifier_value) {
          return res.status(400).json({
            error: "Missing required query params: agent_url, identifier_type, identifier_value",
          });
        }

        const result = await federatedIndex.isPropertyAuthorizedForAgent(
          agent_url as string,
          identifier_type as string,
          identifier_value as string
        );

        res.json({
          agent_url,
          identifier_type,
          identifier_value,
          ...result,
          checked_at: new Date().toISOString(),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Property authorization check failed",
        });
      }
    });

    // ========================================
    // Registry Stats API
    // ========================================

    // GET /api/registry/stats - Get registry statistics
    this.app.get("/api/registry/stats", async (req, res) => {
      try {
        const stats = await federatedIndex.getStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to get registry stats",
        });
      }
    });

  }

  private setupAuthRoutes(): void {
    if (!workos) {
      logger.error('Cannot setup auth routes - WorkOS not initialized');
      return;
    }

    const orgDb = new OrganizationDatabase();

    // GET /auth/login - Redirect to WorkOS for authentication (or dev login page)
    // On AdCP domain, redirect to AAO first to keep auth on a single domain
    // Supports slack_user_id param for auto-linking after login (for existing users)
    this.app.get('/auth/login', (req, res) => {
      try {
        // Dev mode: show dev login page
        if (isDevModeEnabled()) {
          const returnTo = req.query.return_to as string || '/dashboard';
          return res.redirect(`/dev-login.html?return_to=${encodeURIComponent(returnTo)}`);
        }

        // If on AdCP domain, redirect to AAO for login (keeps cookies on single domain)
        if (this.isAdcpDomain(req)) {
          const returnTo = req.query.return_to as string;
          const slackUserId = req.query.slack_user_id as string;
          // Rewrite return_to to AAO domain if it's a relative URL
          let aaoReturnTo = returnTo;
          if (returnTo && returnTo.startsWith('/')) {
            aaoReturnTo = `https://agenticadvertising.org${returnTo}`;
          }
          let redirectUrl = 'https://agenticadvertising.org/auth/login';
          const params = new URLSearchParams();
          if (aaoReturnTo) params.append('return_to', aaoReturnTo);
          if (slackUserId) params.append('slack_user_id', slackUserId);
          if (params.toString()) redirectUrl += `?${params.toString()}`;
          return res.redirect(redirectUrl);
        }

        const returnTo = req.query.return_to as string;
        const slackUserId = req.query.slack_user_id as string;
        const nativeMode = req.query.native === 'true';
        const nativeRedirectUri = req.query.redirect_uri as string;

        // Validate native redirect URI to prevent open redirect attacks
        const ALLOWED_NATIVE_SCHEMES = ['addie://'];
        const isValidNativeRedirectUri = (uri: string): boolean => {
          return ALLOWED_NATIVE_SCHEMES.some(scheme => uri.startsWith(scheme));
        };

        if (nativeMode && nativeRedirectUri && !isValidNativeRedirectUri(nativeRedirectUri)) {
          return res.status(400).json({ error: 'Invalid redirect_uri - must use addie:// scheme' });
        }

        // Build state object with return_to, slack_user_id for auto-linking, and native app params
        const stateObj: { return_to?: string; slack_user_id?: string; native?: boolean; native_redirect_uri?: string } = {};
        if (returnTo) stateObj.return_to = returnTo;
        if (slackUserId) stateObj.slack_user_id = slackUserId;
        if (nativeMode) {
          stateObj.native = true;
          stateObj.native_redirect_uri = nativeRedirectUri || 'addie://auth/callback';
        }
        const state = Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : undefined;

        const authUrl = workos!.userManagement.getAuthorizationUrl({
          provider: 'authkit',
          clientId: WORKOS_CLIENT_ID,
          redirectUri: WORKOS_REDIRECT_URI,
          state,
        });

        res.redirect(authUrl);
      } catch (error) {
        logger.error({ err: error }, 'Login redirect error:');
        res.status(500).json({
          error: 'Failed to initiate login',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /auth/dev-login - Set dev session cookie (dev mode only)
    this.app.post('/auth/dev-login', (req, res) => {
      if (!isDevModeEnabled()) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Validate request is from localhost (defense in depth)
      const host = req.get('host') || '';
      if (!host.startsWith('localhost:') && !host.startsWith('127.0.0.1:')) {
        logger.warn({ host }, 'Dev login attempt from non-localhost host');
        return res.status(403).json({ error: 'Dev login only available on localhost' });
      }

      // Basic CSRF protection: check origin header matches host
      const origin = req.get('origin');
      if (origin) {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          logger.warn({ origin, host }, 'Dev login CSRF check failed');
          return res.status(403).json({ error: 'Origin mismatch' });
        }
      }

      const { user, return_to } = req.body;
      if (!user || !DEV_USERS[user]) {
        return res.status(400).json({ error: 'Invalid user', available: Object.keys(DEV_USERS) });
      }

      // Validate return_to is a relative path to prevent open redirect
      let safeReturnTo = '/dashboard';
      if (return_to && typeof return_to === 'string' && return_to.startsWith('/') && !return_to.startsWith('//')) {
        safeReturnTo = return_to;
      }

      // Set dev session cookie
      res.cookie(getDevSessionCookieName(), user, {
        httpOnly: true,
        secure: false, // Dev mode is always HTTP on localhost
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      logger.info({ user, returnTo: safeReturnTo }, 'Dev login - setting session cookie');
      res.json({ success: true, redirect: safeReturnTo });
    });

    // GET /auth/signup - Redirect to WorkOS with sign-up screen hint
    // Supports slack_user_id param for auto-linking after signup
    this.app.get('/auth/signup', (req, res) => {
      try {
        // If on AdCP domain, redirect to AAO for signup (keeps cookies on single domain)
        if (this.isAdcpDomain(req)) {
          const returnTo = req.query.return_to as string;
          const slackUserId = req.query.slack_user_id as string;
          let aaoReturnTo = returnTo;
          if (returnTo && returnTo.startsWith('/')) {
            aaoReturnTo = `https://agenticadvertising.org${returnTo}`;
          }
          let redirectUrl = 'https://agenticadvertising.org/auth/signup';
          const params = new URLSearchParams();
          if (aaoReturnTo) params.append('return_to', aaoReturnTo);
          if (slackUserId) params.append('slack_user_id', slackUserId);
          if (params.toString()) redirectUrl += `?${params.toString()}`;
          return res.redirect(redirectUrl);
        }

        const returnTo = req.query.return_to as string;
        const slackUserId = req.query.slack_user_id as string;

        // Build state object with return_to and slack_user_id for auto-linking
        const stateObj: { return_to?: string; slack_user_id?: string } = {};
        if (returnTo) stateObj.return_to = returnTo;
        if (slackUserId) stateObj.slack_user_id = slackUserId;
        const state = Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : undefined;

        const authUrl = workos!.userManagement.getAuthorizationUrl({
          provider: 'authkit',
          clientId: WORKOS_CLIENT_ID,
          redirectUri: WORKOS_REDIRECT_URI,
          state,
          screenHint: 'sign-up',
        });

        res.redirect(authUrl);
      } catch (error) {
        logger.error({ err: error }, 'Signup redirect error:');
        res.status(500).json({
          error: 'Failed to initiate signup',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /auth/callback - Handle OAuth callback from WorkOS
    this.app.get('/auth/callback', async (req, res) => {
      const code = req.query.code as string;
      const state = req.query.state as string;

      if (!code) {
        return res.status(400).json({
          error: 'Missing authorization code',
          message: 'No authorization code provided',
        });
      }

      try {
        // Exchange code for sealed session and user info
        const { user, sealedSession } = await workos!.userManagement.authenticateWithCode({
          clientId: WORKOS_CLIENT_ID,
          code,
          session: {
            sealSession: true,
            cookiePassword: WORKOS_COOKIE_PASSWORD,
          },
        });

        logger.info({ userId: user.id }, 'User authenticated via OAuth callback');

        // Check if user needs to accept (or re-accept) ToS and Privacy Policy
        // This happens when:
        // 1. User has never accepted them, OR
        // 2. The version has been updated since they last accepted
        let isFirstTimeUser = false;
        try {
          // Check if user has ANY prior acceptances (to detect first-time users)
          const priorAcceptances = await orgDb.getUserAgreementAcceptances(user.id);
          isFirstTimeUser = priorAcceptances.length === 0;

          const tosAgreement = await orgDb.getCurrentAgreementByType('terms_of_service');
          const privacyAgreement = await orgDb.getCurrentAgreementByType('privacy_policy');

          // Check if user has already accepted the CURRENT version
          const hasAcceptedCurrentTos = tosAgreement
            ? await orgDb.hasUserAcceptedAgreementVersion(user.id, 'terms_of_service', tosAgreement.version)
            : true;

          const hasAcceptedCurrentPrivacy = privacyAgreement
            ? await orgDb.hasUserAcceptedAgreementVersion(user.id, 'privacy_policy', privacyAgreement.version)
            : true;

          // If they haven't accepted the current version, record acceptance
          // (On first login, this auto-accepts. On subsequent logins with updated agreements,
          // they'll be prompted via dashboard modal before this point)
          if (tosAgreement && !hasAcceptedCurrentTos) {
            await orgDb.recordUserAgreementAcceptance({
              workos_user_id: user.id,
              email: user.email,
              agreement_type: 'terms_of_service',
              agreement_version: tosAgreement.version,
              ip_address: req.ip,
              user_agent: req.get('user-agent'),
            });
            logger.debug({ userId: user.id, version: tosAgreement.version }, 'ToS acceptance recorded');
          }

          if (privacyAgreement && !hasAcceptedCurrentPrivacy) {
            await orgDb.recordUserAgreementAcceptance({
              workos_user_id: user.id,
              email: user.email,
              agreement_type: 'privacy_policy',
              agreement_version: privacyAgreement.version,
              ip_address: req.ip,
              user_agent: req.get('user-agent'),
            });
            logger.debug({ userId: user.id, version: privacyAgreement.version }, 'Privacy policy acceptance recorded');
          }
        } catch (agreementError) {
          // Log but don't fail authentication if agreement recording fails
          logger.error({ error: agreementError }, 'Failed to record agreement acceptance');
        }

        // Set sealed session cookie
        res.cookie('wos-session', sealedSession!, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production' && !ALLOW_INSECURE_COOKIES,
          sameSite: 'lax',
          path: '/',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        logger.debug('Session cookie set, checking organization memberships');

        // Check if user belongs to any WorkOS organizations
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        logger.debug({ count: memberships.data.length }, 'Organization memberships retrieved');

        // Record login for engagement tracking (fire and forget)
        if (memberships.data.length > 0) {
          const primaryOrgId = memberships.data[0].organizationId;
          const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
          orgDb.recordUserLogin({
            workos_user_id: user.id,
            workos_organization_id: primaryOrgId,
            user_name: userName,
          }).catch((err) => {
            logger.error({ error: err, userId: user.id }, 'Failed to record user login');
          });
        }

        // Send welcome email to first-time users (async, don't block auth flow)
        if (isFirstTimeUser && memberships.data.length > 0) {
          // Get org details to determine subscription status
          const firstMembership = memberships.data[0];
          const orgId = firstMembership.organizationId;

          // Fire and forget - don't block the auth callback
          (async () => {
            try {
              const org = await orgDb.getOrganization(orgId);
              const workosOrg = await workos!.organizations.getOrganization(orgId);
              const hasActiveSubscription = org?.subscription_status === 'active';

              await sendUserSignupEmail({
                to: user.email,
                firstName: user.firstName || undefined,
                organizationName: workosOrg?.name || org?.name || undefined,
                hasActiveSubscription,
                workosUserId: user.id,
                workosOrganizationId: orgId,
              });

              logger.info({ userId: user.id, orgId, hasActiveSubscription }, 'First-time user signup email sent');
            } catch (emailError) {
              logger.error({ error: emailError, userId: user.id }, 'Failed to send signup email');
            }
          })();
        }

        // Parse return_to, slack_user_id, and native mode from state
        let returnTo = '/dashboard';
        let slackUserIdToLink: string | undefined;
        let isNativeMode = false;
        let nativeRedirectUri = 'addie://auth/callback';
        logger.debug({ state, hasState: !!state }, 'Parsing state for return_to');
        if (state) {
          try {
            const parsedState = JSON.parse(state);
            returnTo = parsedState.return_to || returnTo;
            slackUserIdToLink = parsedState.slack_user_id;
            isNativeMode = parsedState.native === true;
            nativeRedirectUri = parsedState.native_redirect_uri || nativeRedirectUri;
            logger.debug({ parsedState, returnTo, slackUserIdToLink, isNativeMode }, 'Parsed state successfully');
          } catch (e) {
            // Invalid state, use default
            logger.debug({ state, error: String(e) }, 'Failed to parse state');
          }
        }

        // For native app authentication, return JSON with sealed session and redirect to deep link
        if (isNativeMode) {
          logger.info({ userId: user.id, nativeRedirectUri }, 'Native app authentication - redirecting to deep link');

          // Redirect to native app with sealed session as a query parameter
          const redirectUrl = new URL(nativeRedirectUri);
          redirectUrl.searchParams.set('sealed_session', sealedSession!);
          redirectUrl.searchParams.set('user_id', user.id);
          redirectUrl.searchParams.set('email', user.email);
          if (user.firstName) redirectUrl.searchParams.set('first_name', user.firstName);
          if (user.lastName) redirectUrl.searchParams.set('last_name', user.lastName);

          return res.redirect(redirectUrl.toString());
        }

        // Auto-link Slack account if slack_user_id was provided during signup
        if (slackUserIdToLink) {
          try {
            const slackDb = new SlackDatabase();
            const existingMapping = await slackDb.getBySlackUserId(slackUserIdToLink);

            if (existingMapping && !existingMapping.workos_user_id) {
              // Link the Slack user to the newly authenticated WorkOS user
              await slackDb.mapUser({
                slack_user_id: slackUserIdToLink,
                workos_user_id: user.id,
                mapping_source: 'user_claimed',
              });
              logger.info(
                { slackUserId: slackUserIdToLink, workosUserId: user.id },
                'Auto-linked Slack account after signup'
              );

              // Send proactive Addie message if user has a recent conversation
              const firstName = user.firstName || undefined;
              sendAccountLinkedMessage(slackUserIdToLink, firstName).catch((err) => {
                logger.warn({ error: err, slackUserId: slackUserIdToLink }, 'Failed to send Addie account linked message');
              });
            } else if (!existingMapping) {
              logger.debug(
                { slackUserId: slackUserIdToLink },
                'Slack user not found in mapping table, skipping auto-link'
              );
            } else {
              logger.debug(
                { slackUserId: slackUserIdToLink, existingWorkosId: existingMapping.workos_user_id },
                'Slack user already mapped to different WorkOS user'
              );
            }
          } catch (linkError) {
            // Log but don't fail authentication if linking fails
            logger.error({ error: linkError, slackUserId: slackUserIdToLink }, 'Failed to auto-link Slack account');
          }
        }

        // Redirect to dashboard or onboarding
        logger.debug({ returnTo, membershipCount: memberships.data.length }, 'Final redirect decision');
        if (memberships.data.length === 0) {
          logger.debug('No organizations found, redirecting to onboarding');
          res.redirect('/onboarding.html');
        } else {
          logger.debug({ returnTo }, 'Redirecting authenticated user');
          res.redirect(returnTo);
        }
      } catch (error) {
        logger.error({ err: error }, 'Auth callback error:');
        res.status(500).json({
          error: 'Authentication failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });


    // GET /auth/logout - Clear session and redirect
    this.app.get('/auth/logout', async (req, res) => {
      // Dev mode: clear dev-session cookie and redirect to home
      if (isDevModeEnabled()) {
        logger.debug('Dev mode logout - clearing dev session cookie');
        res.clearCookie(getDevSessionCookieName(), {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/',
        });
        return res.redirect('/');
      }

      try {
        const sessionCookie = req.cookies['wos-session'];

        // Invalidate session cache first
        if (sessionCookie) {
          invalidateSessionCache(sessionCookie);
        }

        // Revoke the session on WorkOS side if it exists
        if (sessionCookie && workos) {
          try {
            const result = await workos.userManagement.authenticateWithSessionCookie({
              sessionData: sessionCookie,
              cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
            });

            // If we successfully got the session, revoke it
            if (result.authenticated && 'sessionId' in result && result.sessionId) {
              await workos.userManagement.revokeSession({
                sessionId: result.sessionId,
              });
            }
          } catch (error) {
            // Session might already be invalid, that's okay
            logger.debug({ err: error }, 'Failed to revoke session on WorkOS (may already be invalid)');
          }
        }

        // Clear the cookie - must match the options used when setting it
        res.clearCookie('wos-session', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production' && !ALLOW_INSECURE_COOKIES,
          sameSite: 'lax',
          path: '/',
        });
        res.redirect('/');
      } catch (error) {
        logger.error({ err: error }, 'Error during logout');
        // Still clear the cookie and redirect even if revocation failed
        res.clearCookie('wos-session', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production' && !ALLOW_INSECURE_COOKIES,
          sameSite: 'lax',
          path: '/',
        });
        res.redirect('/');
      }
    });

    // GET /api/me - Get current user info
    this.app.get('/api/me', requireAuth, async (req, res) => {
      try {
        const user = req.user!;

        // Dev mode: return mock data without calling WorkOS
        // Check if user ID matches any dev user
        const devUser = isDevModeEnabled() ? getDevUser(req) : null;
        if (devUser) {
          // In dev mode, look up organizations from our local database
          // All dev users get organizations so we can test dashboard states
          // The billing API returns different subscription status based on isMember flag
          const pool = getPool();
          const result = await pool.query(
            `SELECT workos_organization_id, name, is_personal
             FROM organizations
             WHERE workos_organization_id LIKE 'org_dev_%'
             ORDER BY created_at DESC`
          );

          const organizations = result.rows.map(row => ({
            id: row.workos_organization_id,
            name: row.name,
            role: 'owner', // Dev user is always owner of their orgs
            status: 'active',
            is_personal: row.is_personal || false,
          }));

          return res.json({
            user: {
              id: user.id,
              email: user.email,
              first_name: user.firstName,
              last_name: user.lastName,
              isAdmin: devUser.isAdmin,
            },
            organizations,
            // Include dev mode info for debugging
            dev_mode: {
              enabled: true,
              current_user: devUser.email,
              user_type: devUser.isAdmin ? 'admin' : devUser.isMember ? 'member' : 'nonmember',
              available_users: Object.keys(DEV_USERS),
              switch_hint: 'Log out and log in as a different user',
            },
          });
        }

        // Get user's WorkOS organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        // Map memberships to organization details with roles
        // Fetch organization details separately since membership.organization may be undefined
        const organizations = await Promise.all(
          memberships.data.map(async (membership) => {
            const [workosOrg, localOrg] = await Promise.all([
              workos!.organizations.getOrganization(membership.organizationId),
              orgDb.getOrganization(membership.organizationId),
            ]);
            return {
              id: membership.organizationId,
              name: workosOrg.name,
              // Access role from the membership's role object
              role: membership.role?.slug || 'member',
              status: membership.status,
              is_personal: localOrg?.is_personal || false,
            };
          })
        );

        // Check if user is admin
        const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
        const isAdmin = adminEmails.includes(user.email.toLowerCase());

        // Build response with optional impersonation info
        const response: Record<string, unknown> = {
          user: {
            id: user.id,
            email: user.email,
            first_name: user.firstName,
            last_name: user.lastName,
            isAdmin,
          },
          organizations,
        };

        // Include impersonation info if present
        if (user.impersonator) {
          response.impersonation = {
            active: true,
            impersonator_email: user.impersonator.email,
            reason: user.impersonator.reason,
          };
        }

        res.json(response);
      } catch (error) {
        logger.error({ err: error }, 'Get current user error:');
        res.status(500).json({
          error: 'Failed to get user info',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/agreements - Get user's agreement acceptance history
    this.app.get('/api/me/agreements', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const allAcceptances = await orgDb.getUserAgreementAcceptances(user.id);

        // Deduplicate by agreement type, keeping only the most recent acceptance per type
        // (acceptances are already ordered by accepted_at DESC)
        const acceptancesByType = new Map<string, typeof allAcceptances[0]>();
        for (const acceptance of allAcceptances) {
          if (!acceptancesByType.has(acceptance.agreement_type)) {
            acceptancesByType.set(acceptance.agreement_type, acceptance);
          }
        }
        const acceptances = Array.from(acceptancesByType.values());

        // Get current versions of all agreement types
        const agreementTypes = ['terms_of_service', 'privacy_policy', 'membership'];
        const currentVersions = await Promise.all(
          agreementTypes.map(async (type) => {
            const current = await orgDb.getCurrentAgreementByType(type);
            return { type, current };
          })
        );

        // Format for display and check if any are outdated
        const formattedAcceptances = acceptances.map(acceptance => {
          const currentInfo = currentVersions.find(v => v.type === acceptance.agreement_type);
          const currentVersion = currentInfo?.current?.version;
          const isOutdated = currentVersion && currentVersion !== acceptance.agreement_version;

          return {
            type: acceptance.agreement_type,
            version: acceptance.agreement_version,
            accepted_at: acceptance.accepted_at,
            current_version: currentVersion,
            is_outdated: isOutdated,
            // Optionally include IP/user-agent for audit purposes
            // (consider privacy implications before exposing to UI)
          };
        });

        // Check for any agreements that haven't been accepted at all
        const acceptedTypes = acceptances.map(a => a.agreement_type);
        const missingAcceptances = currentVersions
          .filter(v => v.current && !acceptedTypes.includes(v.type))
          .map(v => ({
            type: v.type,
            version: null,
            accepted_at: null,
            current_version: v.current!.version,
            is_outdated: true,
          }));

        res.json({
          agreements: [...formattedAcceptances, ...missingAcceptances],
          needs_reacceptance: formattedAcceptances.some(a => a.is_outdated) || missingAcceptances.length > 0,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get user agreements error:');
        res.status(500).json({
          error: 'Failed to get agreement history',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/me/agreements/accept - Accept an agreement
    this.app.post('/api/me/agreements/accept', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { agreement_type, version } = req.body;

        if (!agreement_type || !version) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type and version are required',
          });
        }

        const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];
        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy',
          });
        }

        // Record the acceptance
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id: user.id,
          email: user.email,
          agreement_type,
          agreement_version: version,
          ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
          user_agent: req.headers['user-agent'] || 'unknown',
        });

        logger.info({ userId: user.id, agreementType: agreement_type, version }, 'User accepted agreement');

        res.json({
          success: true,
          message: 'Agreement accepted successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Accept agreement error');
        res.status(500).json({
          error: 'Failed to accept agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/addie-home - Get Addie Home content for current user
    this.app.get('/api/me/addie-home', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { getWebHomeContent, renderHomeHTML, ADDIE_HOME_CSS } = await import('./addie/home/index.js');

        const content = await getWebHomeContent(user.id);

        // Check if HTML rendering is requested
        const format = req.query.format as string | undefined;
        if (format === 'html') {
          const html = renderHomeHTML(content);
          res.json({ html, css: ADDIE_HOME_CSS });
        } else {
          // Default: return JSON content
          res.json(content);
        }
      } catch (error) {
        logger.error({ err: error }, 'GET /api/me/addie-home error');
        res.status(500).json({
          error: 'Failed to get Addie home content',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/invitations - Get pending invitations for the current user
    this.app.get('/api/me/invitations', requireAuth, async (req, res) => {
      try {
        const user = req.user!;

        // Get invitations for this user's email
        const invitations = await workos!.userManagement.listInvitations({
          email: user.email,
        });

        // Filter to only pending invitations and get org details
        const pendingInvitations = await Promise.all(
          invitations.data
            .filter(inv => inv.state === 'pending')
            .map(async (inv) => {
              let orgName = 'Organization';
              if (inv.organizationId) {
                try {
                  const org = await workos!.organizations.getOrganization(inv.organizationId);
                  orgName = org.name;
                } catch {
                  // Org may not exist
                }
              }
              return {
                id: inv.id,
                organization_id: inv.organizationId,
                organization_name: orgName,
                email: inv.email,
                role: (inv as any).roleSlug || 'member',
                state: inv.state,
                created_at: inv.createdAt,
                expires_at: inv.expiresAt,
              };
            })
        );

        res.json({ invitations: pendingInvitations });
      } catch (error) {
        logger.error({ err: error }, 'Get user invitations error:');
        res.status(500).json({
          error: 'Failed to get invitations',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/invitations/:invitationId/accept - Accept an invitation
    this.app.post('/api/invitations/:invitationId/accept', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { invitationId } = req.params;

        // Get the invitation to verify it belongs to this user
        const invitation = await workos!.userManagement.getInvitation(invitationId);

        if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'This invitation is not for your email address',
          });
        }

        if (invitation.state !== 'pending') {
          return res.status(400).json({
            error: 'Invalid invitation',
            message: 'This invitation has already been accepted or has expired',
          });
        }

        // Accept the invitation - this creates the membership
        await workos!.userManagement.acceptInvitation(invitationId);

        logger.info({ userId: user.id, invitationId, orgId: invitation.organizationId }, 'User accepted invitation');

        res.json({
          success: true,
          message: 'Invitation accepted successfully',
          organization_id: invitation.organizationId,
        });
      } catch (error) {
        logger.error({ err: error }, 'Accept invitation error:');
        res.status(500).json({
          error: 'Failed to accept invitation',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/joinable-organizations - Get organizations the user can request to join
    // Shows: 1) Published orgs (public member profiles) 2) Orgs with admin matching user's company domain
    this.app.get('/api/me/joinable-organizations', requireAuth, invitationRateLimiter, async (req, res) => {
      try {
        const user = req.user!;
        const memberDb = new MemberDatabase();
        const joinRequestDb = new JoinRequestDatabase();

        // Get user's company domain (null if free email provider)
        const userDomain = getCompanyDomain(user.email);

        // Get all public member profiles (published orgs)
        const publicProfiles = await memberDb.getPublicProfiles({ limit: 100 });

        // Get user's current org memberships to exclude
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });
        const userOrgIds = new Set(userMemberships.data.map(m => m.organizationId));

        // Get user's pending join requests
        const pendingRequests = await joinRequestDb.getUserPendingRequests(user.id);
        const pendingOrgIds = new Set(pendingRequests.map(r => r.workos_organization_id));

        // Build list of joinable orgs from public profiles
        const joinableOrgs: Array<{
          organization_id: string;
          name: string;
          logo_url: string | null;
          tagline: string | null;
          match_reason: 'public' | 'domain';
          request_pending: boolean;
        }> = [];

        for (const profile of publicProfiles) {
          // Skip if user is already a member
          if (userOrgIds.has(profile.workos_organization_id)) {
            continue;
          }

          joinableOrgs.push({
            organization_id: profile.workos_organization_id,
            name: profile.display_name,
            logo_url: profile.logo_url || null,
            tagline: profile.tagline || null,
            match_reason: 'public',
            request_pending: pendingOrgIds.has(profile.workos_organization_id),
          });
        }

        // If user has a company domain, find orgs with admins from the same domain
        if (userDomain) {
          // Get all organizations
          const allOrgs = await workos!.organizations.listOrganizations({ limit: 100 });

          for (const org of allOrgs.data) {
            // Skip if user is already a member or if org is already in list
            if (userOrgIds.has(org.id) || joinableOrgs.some(o => o.organization_id === org.id)) {
              continue;
            }

            // Get org's members to check admin domains
            try {
              const orgMemberships = await workos!.userManagement.listOrganizationMemberships({
                organizationId: org.id,
              });

              // Check if any admin/owner has the same company domain
              const hasMatchingAdmin = orgMemberships.data.some(membership => {
                const role = membership.role?.slug || 'member';
                if (role !== 'admin' && role !== 'owner') {
                  return false;
                }
                const memberEmail = membership.user?.email;
                if (!memberEmail) {
                  return false;
                }
                const memberDomain = getCompanyDomain(memberEmail);
                return memberDomain === userDomain;
              });

              if (hasMatchingAdmin) {
                // Try to get the member profile for logo/tagline
                const profile = await memberDb.getProfileByOrgId(org.id);

                joinableOrgs.push({
                  organization_id: org.id,
                  name: org.name,
                  logo_url: profile?.logo_url || null,
                  tagline: profile?.tagline || null,
                  match_reason: 'domain',
                  request_pending: pendingOrgIds.has(org.id),
                });
              }
            } catch (error) {
              // Skip orgs we can't get memberships for
              logger.debug({ orgId: org.id, err: error }, 'Could not check org memberships');
            }
          }
        }

        res.json({
          organizations: joinableOrgs,
          user_domain: userDomain,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get joinable organizations error:');
        res.status(500).json({
          error: 'Failed to get joinable organizations',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/join-requests - Request to join an organization
    this.app.post('/api/join-requests', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { organization_id } = req.body;

        if (!organization_id) {
          return res.status(400).json({
            error: 'Missing parameter',
            message: 'organization_id is required',
          });
        }

        const joinRequestDb = new JoinRequestDatabase();

        // Check if user is already a member
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: organization_id,
        });

        if (memberships.data.length > 0) {
          return res.status(400).json({
            error: 'Already a member',
            message: 'You are already a member of this organization',
          });
        }

        // Check for existing pending request
        const existingRequest = await joinRequestDb.getPendingRequest(user.id, organization_id);
        if (existingRequest) {
          return res.status(400).json({
            error: 'Request already pending',
            message: 'You already have a pending request to join this organization',
            request_id: existingRequest.id,
          });
        }

        // Get user's full details from WorkOS for name
        let firstName: string | undefined;
        let lastName: string | undefined;
        try {
          const workosUser = await workos!.userManagement.getUser(user.id);
          firstName = workosUser.firstName || undefined;
          lastName = workosUser.lastName || undefined;
        } catch (err) {
          logger.warn({ err, userId: user.id }, 'Failed to get user details from WorkOS');
        }

        // Create the join request
        const request = await joinRequestDb.createRequest({
          workos_user_id: user.id,
          user_email: user.email,
          first_name: firstName,
          last_name: lastName,
          workos_organization_id: organization_id,
        });

        // Get org name for response
        let orgName = 'Organization';
        try {
          const org = await workos!.organizations.getOrganization(organization_id);
          orgName = org.name;
        } catch {
          // Org may not exist
        }

        logger.info({
          userId: user.id,
          orgId: organization_id,
          requestId: request.id,
        }, 'Join request created');

        // Record audit log for join request
        await orgDb.recordAuditLog({
          workos_organization_id: organization_id,
          workos_user_id: user.id,
          action: 'join_request_created',
          resource_type: 'join_request',
          resource_id: request.id,
          details: {
            user_email: user.email,
            first_name: firstName,
            last_name: lastName,
          },
        });

        // Notify org admins via Slack group DM (fire-and-forget)
        (async () => {
          try {
            // Get org admins/owners
            const orgMemberships = await workos!.userManagement.listOrganizationMemberships({
              organizationId: organization_id,
            });
            const adminEmails: string[] = [];
            for (const membership of orgMemberships.data) {
              if (membership.role?.slug === 'admin' || membership.role?.slug === 'owner') {
                try {
                  const adminUser = await workos!.userManagement.getUser(membership.userId);
                  if (adminUser.email) {
                    adminEmails.push(adminUser.email);
                  }
                } catch {
                  // Skip if can't fetch user
                }
              }
            }

            if (adminEmails.length > 0) {
              await notifyJoinRequest({
                orgId: organization_id,
                orgName,
                adminEmails,
                requesterEmail: user.email,
                requesterFirstName: firstName,
                requesterLastName: lastName,
              });
            }
          } catch (err) {
            logger.warn({ err, orgId: organization_id }, 'Failed to notify admins of join request');
          }
        })();

        res.status(201).json({
          success: true,
          message: `Request to join ${orgName} submitted`,
          request: {
            id: request.id,
            organization_id: organization_id,
            organization_name: orgName,
            status: request.status,
            created_at: request.created_at,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Create join request error:');
        res.status(500).json({
          error: 'Failed to create join request',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/join-requests/:requestId - Cancel a pending join request
    this.app.delete('/api/join-requests/:requestId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { requestId } = req.params;

        const joinRequestDb = new JoinRequestDatabase();

        // Cancel the request (will only work if it belongs to this user and is pending)
        const cancelled = await joinRequestDb.cancelRequest(requestId, user.id);

        if (!cancelled) {
          return res.status(404).json({
            error: 'Request not found',
            message: 'No pending join request found with this ID',
          });
        }

        logger.info({ userId: user.id, requestId }, 'Join request cancelled');

        res.json({
          success: true,
          message: 'Join request cancelled',
        });
      } catch (error) {
        logger.error({ err: error }, 'Cancel join request error:');
        res.status(500).json({
          error: 'Failed to cancel join request',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/agreement/current - Get current agreement by type
    this.app.get('/api/agreement/current', async (req, res) => {
      try {
        const type = (req.query.type as string) || 'membership';
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];

        if (!validTypes.includes(type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy'
          });
        }

        const agreement = await orgDb.getCurrentAgreementByType(type);

        if (!agreement) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: `No ${type} agreement found`
          });
        }

        res.json({
          version: agreement.version,
          type: type,
          text: agreement.text,
          effective_date: agreement.effective_date,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get agreement error:');
        res.status(500).json({
          error: 'Failed to get agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/agreement - Get specific agreement by type and version (or current if no version)
    this.app.get('/api/agreement', async (req, res) => {
      try {
        const type = req.query.type as string;
        const version = req.query.version as string;
        const format = req.query.format as string; // 'json' or 'html' (default: html)
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'];

        if (!type) {
          return res.status(400).json({
            error: 'Missing parameters',
            message: 'Type parameter is required'
          });
        }

        if (!validTypes.includes(type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, membership, bylaws, or ip_policy'
          });
        }

        // If version is provided, get that specific version, otherwise get current
        const agreement = version
          ? await orgDb.getAgreementByTypeAndVersion(type, version)
          : await orgDb.getCurrentAgreementByType(type);

        if (!agreement) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: version
              ? `No ${type} agreement found for version ${version}`
              : `No ${type} agreement found`
          });
        }

        // Return JSON if explicitly requested
        if (format === 'json') {
          return res.json({
            version: agreement.version,
            type: type,
            text: agreement.text,
            effective_date: agreement.effective_date,
          });
        }

        // Otherwise render as HTML
        const { marked } = await import('marked');
        const htmlContent = await marked(agreement.text);

        const typeLabels: Record<string, string> = {
          terms_of_service: 'Terms of Service',
          privacy_policy: 'Privacy Policy',
          membership: 'Membership Agreement'
        };

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${typeLabels[type]} - AdCP Registry</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      padding: 40px 20px;
      line-height: 1.6;
      color: #333;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2d3748;
      margin-bottom: 10px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    .content h1 { margin-top: 30px; margin-bottom: 15px; font-size: 24px; }
    .content h2 { margin-top: 30px; margin-bottom: 15px; font-size: 20px; }
    .content h3 { margin-top: 25px; margin-bottom: 10px; font-size: 18px; }
    .content p { margin-bottom: 15px; }
    .content ul, .content ol { margin-bottom: 15px; padding-left: 30px; }
    .content li { margin-bottom: 8px; }
    .back-link {
      display: inline-block;
      margin-top: 30px;
      color: #667eea;
      text-decoration: none;
    }
    .back-link:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${typeLabels[type]}</h1>
    <div class="meta">
      Version ${agreement.version} • Effective Date: ${new Date(agreement.effective_date).toLocaleDateString()}
    </div>
    <div class="content">
      ${htmlContent}
    </div>
    <a href="javascript:window.close()" class="back-link">← Close</a>
  </div>
</body>
</html>
        `;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        logger.error({ err: error }, 'Get agreement error:');
        res.status(500).json({
          error: 'Failed to get agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // NOTE: Organization routes (/api/organizations/*) have been moved to routes/organizations.ts

    // API Key Management Routes using WorkOS

    // Legacy API key endpoints - disabled after migration to WorkOS organizations
    // TODO: Re-implement using WorkOS organization-based access control
    /*
    // POST /api/companies/:companyId/api-keys - Create a new API key
    this.app.post('/api/companies/:companyId/api-keys', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId } = req.params;
        const { name, permissions } = req.body;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser || (companyUser.role !== 'owner' && companyUser.role !== 'admin')) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'Only company owners and admins can create API keys',
          });
        }

        // Create API key via WorkOS
        // Note: WorkOS API Keys product requires organization setup
        // This is demo/placeholder code - real implementation would use crypto.randomBytes()
        const apiKey = {
          id: `key_${Date.now()}`,
          name: name || 'API Key',
          key: `sk_demo_${Math.random().toString(36).substring(2, 15)}`,
          permissions: permissions || ['registry:read', 'registry:write'],
          created_at: new Date().toISOString(),
          company_id: companyId,
        };

        // Log API key creation
        await companyDb.recordAuditLog({
          company_id: companyId,
          user_id: user.id,
          action: 'api_key_created',
          resource_type: 'api_key',
          resource_id: apiKey.id,
          details: { name: apiKey.name, permissions: apiKey.permissions },
        });

        res.json({
          success: true,
          api_key: apiKey,
          warning: 'Store this key securely - it will not be shown again',
        });
      } catch (error) {
        logger.error({ err: error }, 'Create API key error:');
        res.status(500).json({
          error: 'Failed to create API key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/companies/:companyId/api-keys - List API keys for a company
    this.app.get('/api/companies/:companyId/api-keys', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId } = req.params;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You do not have access to this company',
          });
        }

        // In a real implementation, this would query WorkOS for the company's API keys
        // For now, return empty array as placeholder
        res.json({
          api_keys: [],
          message: 'WorkOS API Keys integration coming soon',
        });
      } catch (error) {
        logger.error({ err: error }, 'List API keys error:');
        res.status(500).json({
          error: 'Failed to list API keys',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/companies/:companyId/api-keys/:keyId - Revoke an API key
    this.app.delete('/api/companies/:companyId/api-keys/:keyId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId, keyId } = req.params;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser || (companyUser.role !== 'owner' && companyUser.role !== 'admin')) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'Only company owners and admins can revoke API keys',
          });
        }

        // Revoke via WorkOS (placeholder)
        // In production: await workos!.apiKeys.revoke(keyId);

        // Log API key revocation
        await companyDb.recordAuditLog({
          company_id: companyId,
          user_id: user.id,
          action: 'api_key_revoked',
          resource_type: 'api_key',
          resource_id: keyId,
          details: {},
        });

        res.json({
          success: true,
          message: 'API key revoked successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Revoke API key error:');
        res.status(500).json({
          error: 'Failed to revoke API key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
    */

    // Member Profile Routes
    const memberDb = new MemberDatabase();

    // GET /api/members - List public member profiles (for directory)
    this.app.get('/api/members', async (req, res) => {
      try {
        const { search, offerings, markets, limit, offset } = req.query;

        const profiles = await memberDb.getPublicProfiles({
          search: search as string,
          offerings: offerings ? (offerings as string).split(',') as any : undefined,
          markets: markets ? (markets as string).split(',') : undefined,
          limit: limit ? parseInt(limit as string, 10) : 50,
          offset: offset ? parseInt(offset as string, 10) : 0,
        });

        res.json({ members: profiles });
      } catch (error) {
        logger.error({ err: error }, 'List members error');
        res.status(500).json({
          error: 'Failed to list members',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/members/carousel - Get member profiles for homepage carousel
    this.app.get('/api/members/carousel', async (req, res) => {
      try {
        const profiles = await memberDb.getCarouselProfiles();
        res.json({ members: profiles });
      } catch (error) {
        logger.error({ err: error }, 'Get carousel members error');
        res.status(500).json({
          error: 'Failed to get carousel members',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/members/:slug - Get single member profile by slug
    this.app.get('/api/members/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const profile = await memberDb.getProfileBySlug(slug);

        if (!profile) {
          return res.status(404).json({
            error: 'Member not found',
            message: `No member found with slug: ${slug}`,
          });
        }

        // Only return if public (unless authenticated user owns it)
        if (!profile.is_public) {
          // Check if authenticated user owns this profile
          const sessionCookie = req.cookies?.['wos-session'];
          if (!sessionCookie || !AUTH_ENABLED || !workos) {
            return res.status(404).json({
              error: 'Member not found',
              message: `No member found with slug: ${slug}`,
            });
          }

          try {
            const result = await workos.userManagement.authenticateWithSessionCookie({
              sessionData: sessionCookie,
              cookiePassword: WORKOS_COOKIE_PASSWORD,
            });

            if (!result.authenticated || !('user' in result) || !result.user) {
              return res.status(404).json({
                error: 'Member not found',
                message: `No member found with slug: ${slug}`,
              });
            }

            // Check if user is member of the organization
            const memberships = await workos.userManagement.listOrganizationMemberships({
              userId: result.user.id,
              organizationId: profile.workos_organization_id,
            });

            if (memberships.data.length === 0) {
              return res.status(404).json({
                error: 'Member not found',
                message: `No member found with slug: ${slug}`,
              });
            }
          } catch {
            return res.status(404).json({
              error: 'Member not found',
              message: `No member found with slug: ${slug}`,
            });
          }
        }

        res.json({ member: profile });
      } catch (error) {
        logger.error({ err: error }, 'Get member error');
        res.status(500).json({
          error: 'Failed to get member',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/members/:slug/click - Track a profile click for analytics
    this.app.post('/api/members/:slug/click', async (req, res) => {
      try {
        const { slug } = req.params;
        const { search_session_id } = req.body;

        // Import analytics db lazily
        const { MemberSearchAnalyticsDatabase } = await import('./db/member-search-analytics-db.js');
        const analyticsDb = new MemberSearchAnalyticsDatabase();

        // Get the profile to get its ID
        const profile = await memberDb.getProfileBySlug(slug);
        if (!profile) {
          return res.status(404).json({ error: 'Member not found' });
        }

        // Get user ID if authenticated
        let userId: string | undefined;
        const sessionCookie = req.cookies?.['wos-session'];
        if (sessionCookie && AUTH_ENABLED && workos) {
          try {
            const result = await workos.userManagement.authenticateWithSessionCookie({
              sessionData: sessionCookie,
              cookiePassword: WORKOS_COOKIE_PASSWORD,
            });
            if (result.authenticated && 'user' in result && result.user) {
              userId = result.user.id;
            }
          } catch {
            // Not authenticated - that's fine
          }
        }

        // Record the click
        await analyticsDb.recordProfileClick({
          member_profile_id: profile.id,
          searcher_user_id: userId,
          search_session_id,
        });

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'Record member click error');
        res.status(500).json({ error: 'Failed to record click' });
      }
    });

    // GET /api/public/discover-agent - Public endpoint to discover agent info (for members directory)
    this.app.get('/api/public/discover-agent', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // Use SingleAgentClient which handles protocol detection and connection automatically
        const client = new SingleAgentClient({
          id: 'discovery',
          name: 'discovery-client',
          agent_uri: url,
          protocol: 'mcp', // Library handles protocol detection internally
        });

        // getAgentInfo() handles all the protocol detection and tool discovery
        const agentInfo = await client.getAgentInfo();
        const tools = agentInfo.tools || [];

        // Detect agent type from tools
        // Check for sales first since sales agents may also expose creative tools
        let agentType = 'unknown';
        const toolNames = tools.map((t: { name: string }) => t.name.toLowerCase());
        if (toolNames.some((n: string) => n.includes('get_product') || n.includes('media_buy') || n.includes('create_media'))) {
          agentType = 'sales';
        } else if (toolNames.some((n: string) => n.includes('signal') || n.includes('audience'))) {
          agentType = 'signals';
        } else if (toolNames.some((n: string) => n.includes('creative') || n.includes('format') || n.includes('preview'))) {
          agentType = 'creative';
        }

        // The library returns our config name, so extract real name from URL or use hostname
        const hostname = new URL(url).hostname;
        const agentName = (agentInfo.name && agentInfo.name !== 'discovery-client')
          ? agentInfo.name
          : hostname;

        // Detect protocols - check if both MCP and A2A are available
        const protocols: string[] = [agentInfo.protocol];
        try {
          // Check for A2A agent card if we detected MCP
          if (agentInfo.protocol === 'mcp') {
            const a2aUrl = new URL('/.well-known/agent.json', url).toString();
            const a2aResponse = await fetch(a2aUrl, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(3000),
            });
            if (a2aResponse.ok) {
              protocols.push('a2a');
            }
          }
        } catch {
          // Ignore A2A check failures
        }

        // Fetch type-specific stats
        let stats: {
          format_count?: number;
          product_count?: number;
          publisher_count?: number;
        } = {};

        if (agentType === 'creative') {
          try {
            const creativeClient = new CreativeAgentClient({ agentUrl: url });
            const formats = await creativeClient.listFormats();
            stats.format_count = formats.length;
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch creative formats');
            stats.format_count = 0;
          }
        } else if (agentType === 'sales') {
          // Always show product and publisher counts for sales agents
          stats.product_count = 0;
          stats.publisher_count = 0;
          try {
            const result = await client.getProducts({ brief: '' });
            if (result.data?.products) {
              stats.product_count = result.data.products.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch products');
          }
          try {
            const pubResult = await client.listAuthorizedProperties({});
            if (pubResult.data?.publisher_domains) {
              stats.publisher_count = pubResult.data.publisher_domains.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch publishers');
          }
        }

        return res.json({
          name: agentName,
          description: agentInfo.description,
          protocols,
          type: agentType,
          stats,
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Public agent discovery error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within 10 seconds',
          });
        }

        return res.status(500).json({
          error: 'Agent discovery failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/public/agent-formats - Public endpoint to fetch creative formats from a creative agent
    this.app.get('/api/public/agent-formats', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // CreativeAgentClient handles protocol detection internally
        const creativeClient = new CreativeAgentClient({
          agentUrl: url,
        });

        const formats = await creativeClient.listFormats();

        return res.json({
          success: true,
          formats: formats.map(format => ({
            format_id: format.format_id,
            name: format.name,
            type: format.type,
            description: format.description,
            preview_image: format.preview_image,
            example_url: format.example_url,
            renders: format.renders,
            assets_required: format.assets_required,
            output_format_ids: format.output_format_ids,
            agent_url: format.agent_url,
          })),
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent formats fetch error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within the timeout period',
          });
        }

        return res.status(500).json({
          error: 'Failed to fetch formats',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/public/agent-products - Public endpoint to fetch products from a sales agent
    this.app.get('/api/public/agent-products', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        const client = new SingleAgentClient({
          id: 'products-discovery',
          name: 'products-discovery-client',
          agent_uri: url,
          protocol: 'mcp',
        });

        const result = await client.getProducts({ brief: '' });
        const products = result.data?.products || [];

        return res.json({
          success: true,
          products: products.map((p: any) => ({
            product_id: p.product_id,
            name: p.name,
            description: p.description,
            property_type: p.property_type,
            property_name: p.property_name,
            pricing_model: p.pricing_model,
            base_rate: p.base_rate,
            currency: p.currency,
            format_ids: p.format_ids,
            delivery_channels: p.delivery_channels,
            // Include any targeting or audience info if available
            targeting_capabilities: p.targeting_capabilities,
          })),
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent products fetch error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within the timeout period',
          });
        }

        return res.status(500).json({
          error: 'Failed to fetch products',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/public/agent-publishers - Public endpoint to fetch authorized publishers from a sales agent
    this.app.get('/api/public/agent-publishers', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        const client = new SingleAgentClient({
          id: 'publishers-discovery',
          name: 'publishers-discovery-client',
          agent_uri: url,
          protocol: 'mcp',
        });

        const result = await client.listAuthorizedProperties({});
        const publishers = (result.data as any)?.publisher_domains || [];

        // Build enriched publisher info
        const enrichedPublishers = publishers.map((domain: string) => {
          const properties = (result.data as any)?.properties?.filter((p: any) => p.domain === domain) || [];
          return {
            domain,
            property_count: properties.length,
            property_types: [...new Set(properties.map((p: any) => p.type))],
            properties: properties.slice(0, 10).map((p: any) => ({
              type: p.type,
              name: p.name,
              value: p.value,
            })),
          };
        });

        return res.json({
          success: true,
          publishers: enrichedPublishers,
          total_properties: (result.data as any)?.properties?.length || 0,
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent publishers fetch error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within the timeout period',
          });
        }

        return res.status(500).json({
          error: 'Failed to fetch publishers',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/member-profile - Get current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.get('/api/me/member-profile', requireAuth, async (req, res) => {
      const startTime = Date.now();
      logger.info({ userId: req.user?.id, org: req.query.org }, 'GET /api/me/member-profile started');
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;

        // Dev mode: handle dev organizations without WorkOS
        const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
        if (isDevUserProfile) {
          const localOrg = await orgDb.getOrganization(requestedOrgId!);
          if (!localOrg) {
            return res.status(404).json({
              error: 'Organization not found',
              message: 'The requested organization does not exist',
            });
          }
          const profile = await memberDb.getProfileByOrgId(requestedOrgId!);
          logger.info({ userId: user.id, orgId: requestedOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed (dev mode)');
          return res.json({
            profile: profile || null,
            organization_id: requestedOrgId,
            organization_name: localOrg.name,
          });
        }

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          logger.info({ userId: user.id, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile: no organization');
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          // Verify user is a member of the requested org
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            logger.info({ userId: user.id, requestedOrgId, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile: not authorized');
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          // Default to first org
          targetOrgId = memberships.data[0].organizationId;
        }

        const profile = await memberDb.getProfileByOrgId(targetOrgId);

        // Get org name from WorkOS
        const org = await workos!.organizations.getOrganization(targetOrgId);

        logger.info({ userId: user.id, orgId: targetOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed');
        res.json({
          profile: profile || null,
          organization_id: targetOrgId,
          organization_name: org.name,
        });
      } catch (error) {
        logger.error({ err: error, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile error');
        res.status(500).json({
          error: 'Failed to get member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/me/member-profile - Create member profile for current user's organization
    // Supports ?org=org_id query parameter to specify which organization
    this.app.post('/api/me/member-profile', requireAuth, async (req, res) => {
      const startTime = Date.now();
      logger.info({ userId: req.user?.id, org: req.query.org }, 'POST /api/me/member-profile started');
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const {
          display_name,
          slug,
          tagline,
          description,
          logo_url,
          logo_light_url,
          logo_dark_url,
          brand_color,
          contact_email,
          contact_website,
          contact_phone,
          linkedin_url,
          twitter_url,
          offerings,
          agents,
          headquarters,
          markets,
          tags,
          is_public,
          show_in_carousel,
        } = req.body;

        // Validate required fields
        if (!display_name || !slug) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'display_name and slug are required',
          });
        }

        // Validate slug format and reserved words
        if (!isValidSlug(slug)) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens, cannot start or end with a hyphen, and cannot be a reserved keyword (admin, api, auth, dashboard, members, registry, onboarding)',
          });
        }

        // Dev mode: handle dev organizations without WorkOS
        const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');

        let targetOrgId: string;

        if (isDevUserProfile) {
          // Dev mode: use the requested dev org directly
          const localOrg = await orgDb.getOrganization(requestedOrgId!);
          if (!localOrg) {
            return res.status(404).json({
              error: 'Organization not found',
              message: 'The requested organization does not exist',
            });
          }
          targetOrgId = requestedOrgId!;
          logger.info({ userId: user.id, orgId: targetOrgId }, 'POST /api/me/member-profile: dev mode bypass');
        } else {
          // Normal mode: check WorkOS memberships
          const memberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
          });

          if (memberships.data.length === 0) {
            return res.status(400).json({
              error: 'No organization',
              message: 'User must be a member of an organization to create a profile',
            });
          }

          if (requestedOrgId) {
            // Verify user is a member of the requested org
            const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
            if (!isMember) {
              return res.status(403).json({
                error: 'Not authorized',
                message: 'User is not a member of the requested organization',
              });
            }
            targetOrgId = requestedOrgId;
          } else {
            // Default to first org
            targetOrgId = memberships.data[0].organizationId;
          }
        }

        // Ensure organization exists in local DB (on-demand sync from WorkOS, skip for dev mode)
        let org = await orgDb.getOrganization(targetOrgId);
        if (!org && !isDevUserProfile) {
          try {
            const workosOrg = await workos!.organizations.getOrganization(targetOrgId);
            if (workosOrg) {
              org = await orgDb.createOrganization({
                workos_organization_id: workosOrg.id,
                name: workosOrg.name,
              });
              logger.info({ orgId: targetOrgId, name: workosOrg.name }, 'On-demand synced organization from WorkOS for member profile');
            }
          } catch (syncError) {
            logger.warn({ orgId: targetOrgId, err: syncError }, 'Failed to sync organization from WorkOS');
          }
        }

        if (!org) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'Organization does not exist. Please contact support.',
          });
        }

        // Check if profile already exists for this org
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (existingProfile) {
          return res.status(409).json({
            error: 'Profile already exists',
            message: 'Organization already has a member profile. Use PUT to update.',
          });
        }

        // Check slug availability
        const slugAvailable = await memberDb.isSlugAvailable(slug);
        if (!slugAvailable) {
          return res.status(409).json({
            error: 'Slug not available',
            message: 'This slug is already taken. Please choose a different one.',
          });
        }

        // Validate offerings if provided
        const validOfferings = ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'consulting', 'other'];
        if (offerings && Array.isArray(offerings)) {
          const invalidOfferings = offerings.filter((o: string) => !validOfferings.includes(o));
          if (invalidOfferings.length > 0) {
            return res.status(400).json({
              error: 'Invalid offerings',
              message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${validOfferings.join(', ')}`,
            });
          }
        }

        const profile = await memberDb.createProfile({
          workos_organization_id: targetOrgId,
          display_name,
          slug,
          tagline,
          description,
          logo_url,
          logo_light_url,
          logo_dark_url,
          brand_color,
          contact_email,
          contact_website,
          contact_phone,
          linkedin_url,
          twitter_url,
          offerings: offerings || [],
          agents: agents || [],
          headquarters,
          markets: markets || [],
          tags: tags || [],
          is_public: is_public ?? false,
          show_in_carousel: show_in_carousel ?? false,
        });

        // Invalidate Addie's member context cache - organization profile created
        invalidateMemberContextCache();

        logger.info({ profileId: profile.id, orgId: targetOrgId, slug, durationMs: Date.now() - startTime }, 'POST /api/me/member-profile completed');

        res.status(201).json({ profile });
      } catch (error) {
        logger.error({ err: error, durationMs: Date.now() - startTime }, 'POST /api/me/member-profile error');
        res.status(500).json({
          error: 'Failed to create member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/me/member-profile - Update current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.put('/api/me/member-profile', requireAuth, async (req, res) => {
      const startTime = Date.now();
      logger.info({ userId: req.user?.id }, 'PUT /api/me/member-profile started');
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const updates = req.body;

        // Dev mode: handle dev organizations without WorkOS
        const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');

        let targetOrgId: string;

        if (isDevUserProfile) {
          // Dev mode: use the requested dev org directly
          const localOrg = await orgDb.getOrganization(requestedOrgId!);
          if (!localOrg) {
            return res.status(404).json({
              error: 'Organization not found',
              message: 'The requested organization does not exist',
            });
          }
          targetOrgId = requestedOrgId!;
          logger.info({ userId: user.id, orgId: targetOrgId }, 'PUT /api/me/member-profile: dev mode bypass');
        } else {
          // Normal mode: check WorkOS memberships
          const memberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
          });

          if (memberships.data.length === 0) {
            return res.status(400).json({
              error: 'No organization',
              message: 'User must be a member of an organization to update a profile',
            });
          }

          if (requestedOrgId) {
            const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
            if (!isMember) {
              return res.status(403).json({
                error: 'Not authorized',
                message: 'User is not a member of the requested organization',
              });
            }
            targetOrgId = requestedOrgId;
          } else {
            targetOrgId = memberships.data[0].organizationId;
          }
        }

        // Check if profile exists
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (!existingProfile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: 'No member profile exists for your organization. Use POST to create one.',
          });
        }

        // Validate offerings if provided
        const validOfferings = ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'consulting', 'other'];
        if (updates.offerings && Array.isArray(updates.offerings)) {
          const invalidOfferings = updates.offerings.filter((o: string) => !validOfferings.includes(o));
          if (invalidOfferings.length > 0) {
            return res.status(400).json({
              error: 'Invalid offerings',
              message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${validOfferings.join(', ')}`,
            });
          }
        }

        // Remove fields that shouldn't be updated directly
        delete updates.id;
        delete updates.workos_organization_id;
        delete updates.slug; // Slug changes not allowed via this endpoint
        delete updates.created_at;
        delete updates.updated_at;
        delete updates.featured; // Only admins can set featured

        const profile = await memberDb.updateProfileByOrgId(targetOrgId, updates);

        // Invalidate Addie's member context cache - organization profile updated
        invalidateMemberContextCache();

        const duration = Date.now() - startTime;
        logger.info({ profileId: profile?.id, orgId: targetOrgId, durationMs: duration }, 'Member profile updated');

        res.json({ profile });
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error({ err: error, durationMs: duration }, 'Update member profile error');
        res.status(500).json({
          error: 'Failed to update member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/me/member-profile/visibility - Update visibility only (with subscription check)
    // Supports ?org=org_id query parameter to specify which organization
    this.app.put('/api/me/member-profile/visibility', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const { is_public, show_in_carousel } = req.body;

        // Validate request body
        if (typeof is_public !== 'boolean') {
          return res.status(400).json({
            error: 'Invalid request',
            message: 'is_public must be a boolean',
          });
        }

        // Dev mode: handle dev organizations without WorkOS
        const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');

        let targetOrgId: string;

        if (isDevUserProfile) {
          // Dev mode: use the requested dev org directly
          const localOrg = await orgDb.getOrganization(requestedOrgId!);
          if (!localOrg) {
            return res.status(404).json({
              error: 'Organization not found',
              message: 'The requested organization does not exist',
            });
          }
          targetOrgId = requestedOrgId!;
          logger.info({ userId: user.id, orgId: targetOrgId }, 'PUT /api/me/member-profile/visibility: dev mode bypass');
        } else {
          // Normal mode: check WorkOS memberships
          const memberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
          });

          if (memberships.data.length === 0) {
            return res.status(400).json({
              error: 'No organization',
              message: 'User must be a member of an organization to update visibility',
            });
          }

          if (requestedOrgId) {
            const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
            if (!isMember) {
              return res.status(403).json({
                error: 'Not authorized',
                message: 'User is not a member of the requested organization',
              });
            }
            targetOrgId = requestedOrgId;
          } else {
            targetOrgId = memberships.data[0].organizationId;
          }
        }

        // Check if profile exists
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (!existingProfile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: 'No member profile exists for your organization.',
          });
        }

        // If trying to make public, check subscription status
        if (is_public) {
          const subscriptionInfo = await orgDb.getSubscriptionInfo(targetOrgId);
          if (!subscriptionInfo || subscriptionInfo.status !== 'active') {
            return res.status(403).json({
              error: 'Subscription required',
              message: 'An active membership subscription is required to make your profile public.',
            });
          }
        }

        // Update visibility
        const profile = await memberDb.updateProfileByOrgId(targetOrgId, {
          is_public,
          show_in_carousel: show_in_carousel ?? is_public, // Default to match is_public
        });

        // Invalidate Addie's member context cache - organization profile visibility changed
        invalidateMemberContextCache();

        logger.info({ profileId: profile?.id, orgId: targetOrgId, is_public }, 'Member profile visibility updated');

        res.json({ profile });
      } catch (error) {
        logger.error({ err: error }, 'Update member profile visibility error');
        res.status(500).json({
          error: 'Failed to update visibility',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/me/member-profile - Delete current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.delete('/api/me/member-profile', requireAuth, async (req, res) => {
      const startTime = Date.now();
      logger.info({ userId: req.user?.id, org: req.query.org }, 'DELETE /api/me/member-profile started');
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;

        // Dev mode: handle dev organizations without WorkOS
        const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');

        let targetOrgId: string;

        if (isDevUserProfile) {
          // Dev mode: use the requested dev org directly
          const localOrg = await orgDb.getOrganization(requestedOrgId!);
          if (!localOrg) {
            return res.status(404).json({
              error: 'Organization not found',
              message: 'The requested organization does not exist',
            });
          }
          targetOrgId = requestedOrgId!;
          logger.info({ userId: user.id, orgId: targetOrgId }, 'DELETE /api/me/member-profile: dev mode bypass');
        } else {
          // Normal mode: check WorkOS memberships
          const memberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
          });

          if (memberships.data.length === 0) {
            return res.status(400).json({
              error: 'No organization',
              message: 'User must be a member of an organization',
            });
          }

          if (requestedOrgId) {
            const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
            if (!isMember) {
              return res.status(403).json({
                error: 'Not authorized',
                message: 'User is not a member of the requested organization',
              });
            }
            targetOrgId = requestedOrgId;
          } else {
            targetOrgId = memberships.data[0].organizationId;
          }
        }

        // Check if profile exists
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (!existingProfile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: 'No member profile exists for your organization',
          });
        }

        await memberDb.deleteProfile(existingProfile.id);

        // Invalidate Addie's member context cache - organization profile deleted
        invalidateMemberContextCache();

        logger.info({ profileId: existingProfile.id, orgId: targetOrgId, durationMs: Date.now() - startTime }, 'DELETE /api/me/member-profile completed');

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error, durationMs: Date.now() - startTime }, 'DELETE /api/me/member-profile error');
        res.status(500).json({
          error: 'Failed to delete member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Admin routes for member profiles
    // GET /api/admin/member-profiles - List all member profiles (admin)
    this.app.get('/api/admin/member-profiles', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { is_public, search, limit, offset } = req.query;

        const profiles = await memberDb.listProfiles({
          is_public: is_public === 'true' ? true : is_public === 'false' ? false : undefined,
          search: search as string,
          limit: limit ? parseInt(limit as string, 10) : 100,
          offset: offset ? parseInt(offset as string, 10) : 0,
        });

        res.json({ profiles });
      } catch (error) {
        logger.error({ err: error }, 'Admin list member profiles error');
        res.status(500).json({
          error: 'Failed to list member profiles',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/admin/member-profiles/:id - Update any member profile (admin)
    this.app.put('/api/admin/member-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const updates = req.body;

        // Remove fields that shouldn't be updated
        delete updates.id;
        delete updates.workos_organization_id;
        delete updates.created_at;
        delete updates.updated_at;

        const profile = await memberDb.updateProfile(id, updates);

        if (!profile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: `No member profile found with ID: ${id}`,
          });
        }

        // Invalidate Addie's member context cache - organization profile updated by admin
        invalidateMemberContextCache();

        logger.info({ profileId: id, adminUpdate: true }, 'Member profile updated by admin');

        res.json({ profile });
      } catch (error) {
        logger.error({ err: error }, 'Admin update member profile error');
        res.status(500).json({
          error: 'Failed to update member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/admin/member-profiles/:id - Delete any member profile (admin)
    this.app.delete('/api/admin/member-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        const deleted = await memberDb.deleteProfile(id);

        if (!deleted) {
          return res.status(404).json({
            error: 'Profile not found',
            message: `No member profile found with ID: ${id}`,
          });
        }

        // Invalidate Addie's member context cache - organization profile deleted by admin
        invalidateMemberContextCache();

        logger.info({ profileId: id, adminDelete: true }, 'Member profile deleted by admin');

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'Admin delete member profile error');
        res.status(500).json({
          error: 'Failed to delete member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Note: Prospect management routes are now in routes/admin.ts
    // Routes: GET/POST /api/admin/prospects, POST /api/admin/prospects/bulk,
    //         PUT /api/admin/prospects/:orgId, GET /api/admin/prospects/stats,
    //         GET /api/admin/organizations

    // NOTE: Agent management is now handled through member profiles.
    // Agents are stored in the member_profiles.agents JSONB array.
    // Use PUT /api/me/member-profile to update agents.

    // Note: Slack Admin routes have been moved to routes/slack.ts
    // Routes: GET /api/admin/slack/status, /stats, /users, /unified, /unmapped, /auto-link-suggested
    //         POST /api/admin/slack/sync, /users/:id/link, /users/:id/unlink, /auto-link-suggested

    // ============== Admin Email Endpoints ==============

    // GET /api/admin/email/stats - Email statistics for admin dashboard
    this.app.get('/api/admin/email/stats', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();

        // Get total emails sent
        const sentResult = await pool.query(
          `SELECT COUNT(*) as count FROM email_events WHERE sent_at IS NOT NULL`
        );
        const totalSent = parseInt(sentResult.rows[0]?.count || '0');

        // Get open rate
        const openResult = await pool.query(
          `SELECT
            COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
            COUNT(*) as total
           FROM email_events
           WHERE sent_at IS NOT NULL`
        );
        const avgOpenRate = openResult.rows[0]?.total > 0
          ? (parseInt(openResult.rows[0].opened) / parseInt(openResult.rows[0].total)) * 100
          : 0;

        // Get click rate
        const clickResult = await pool.query(
          `SELECT
            COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL) as clicked,
            COUNT(*) as total
           FROM email_events
           WHERE sent_at IS NOT NULL`
        );
        const avgClickRate = clickResult.rows[0]?.total > 0
          ? (parseInt(clickResult.rows[0].clicked) / parseInt(clickResult.rows[0].total)) * 100
          : 0;

        // Get campaign count
        const campaignResult = await pool.query(
          `SELECT COUNT(*) as count FROM email_campaigns`
        );
        const totalCampaigns = parseInt(campaignResult.rows[0]?.count || '0');

        res.json({
          total_sent: totalSent,
          avg_open_rate: avgOpenRate,
          avg_click_rate: avgClickRate,
          total_campaigns: totalCampaigns,
        });
      } catch (error) {
        logger.error({ error }, 'Error fetching email stats');
        res.status(500).json({ error: 'Failed to fetch email stats' });
      }
    });

    // GET /api/admin/email/campaigns - List all campaigns
    this.app.get('/api/admin/email/campaigns', requireAuth, requireAdmin, async (req, res) => {
      try {
        const campaigns = await emailPrefsDb.getCampaigns();
        res.json({ campaigns });
      } catch (error) {
        logger.error({ error }, 'Error fetching campaigns');
        res.status(500).json({ error: 'Failed to fetch campaigns' });
      }
    });

    // GET /api/admin/email/templates - List all templates
    this.app.get('/api/admin/email/templates', requireAuth, requireAdmin, async (req, res) => {
      try {
        const templates = await emailPrefsDb.getTemplates();
        res.json({ templates });
      } catch (error) {
        logger.error({ error }, 'Error fetching templates');
        res.status(500).json({ error: 'Failed to fetch templates' });
      }
    });

    // GET /api/admin/email/recent - Recent email sends
    this.app.get('/api/admin/email/recent', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        const result = await pool.query(
          `SELECT *
           FROM email_events
           ORDER BY created_at DESC
           LIMIT 100`
        );
        res.json({ emails: result.rows });
      } catch (error) {
        logger.error({ error }, 'Error fetching recent emails');
        res.status(500).json({ error: 'Failed to fetch recent emails' });
      }
    });

    // Note: Slack Public routes have been moved to routes/slack.ts
    // AAO Bot: POST /api/slack/aaobot/commands, /api/slack/aaobot/events
    // Addie: POST /api/slack/addie/events (Bolt SDK)

    // Utility: Check slug availability
    this.app.get('/api/members/check-slug/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const available = await memberDb.isSlugAvailable(slug);
        res.json({ available, slug });
      } catch (error) {
        logger.error({ err: error }, 'Check slug error');
        res.status(500).json({
          error: 'Failed to check slug availability',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Agent Discovery: Fetch agent info from URL
    this.app.get('/api/discover-agent', requireAuth, async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // Use SingleAgentClient which handles protocol detection and connection automatically
        const client = new SingleAgentClient({
          id: 'discovery',
          name: 'discovery-client',
          agent_uri: url,
          protocol: 'mcp', // Library handles protocol detection internally
        });

        // getAgentInfo() handles all the protocol detection and tool discovery
        const agentInfo = await client.getAgentInfo();
        const tools = agentInfo.tools || [];

        // Detect agent type from tools
        // Check for sales first since sales agents may also expose creative tools
        let agentType = 'unknown';
        const toolNames = tools.map((t: { name: string }) => t.name.toLowerCase());
        if (toolNames.some((n: string) => n.includes('get_product') || n.includes('media_buy') || n.includes('create_media'))) {
          agentType = 'sales';
        } else if (toolNames.some((n: string) => n.includes('signal') || n.includes('audience'))) {
          agentType = 'signals';
        } else if (toolNames.some((n: string) => n.includes('creative') || n.includes('format') || n.includes('preview'))) {
          agentType = 'creative';
        }

        // The library returns our config name, so extract real name from URL or use hostname
        const hostname = new URL(url).hostname;
        const agentName = (agentInfo.name && agentInfo.name !== 'discovery-client')
          ? agentInfo.name
          : hostname;

        // Detect protocols - check if both MCP and A2A are available
        const protocols: string[] = [agentInfo.protocol];
        try {
          // Check for A2A agent card if we detected MCP
          if (agentInfo.protocol === 'mcp') {
            const a2aUrl = new URL('/.well-known/agent.json', url).toString();
            const a2aResponse = await fetch(a2aUrl, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(3000),
            });
            if (a2aResponse.ok) {
              protocols.push('a2a');
            }
          }
        } catch {
          // Ignore A2A check failures
        }

        // Fetch type-specific stats
        let stats: {
          format_count?: number;
          product_count?: number;
          publisher_count?: number;
        } = {};

        if (agentType === 'creative') {
          try {
            const creativeClient = new CreativeAgentClient({ agentUrl: url });
            const formats = await creativeClient.listFormats();
            stats.format_count = formats.length;
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch creative formats');
            stats.format_count = 0;
          }
        } else if (agentType === 'sales') {
          // Always show product and publisher counts for sales agents
          stats.product_count = 0;
          stats.publisher_count = 0;
          try {
            const result = await client.getProducts({ brief: '' });
            if (result.data?.products) {
              stats.product_count = result.data.products.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch products');
          }
          try {
            const pubResult = await client.listAuthorizedProperties({});
            if (pubResult.data?.publisher_domains) {
              stats.publisher_count = pubResult.data.publisher_domains.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch publishers');
          }
        }

        return res.json({
          name: agentName,
          description: agentInfo.description,
          protocols,
          type: agentType,
          stats,
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent discovery error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within 10 seconds',
          });
        }

        return res.status(500).json({
          error: 'Agent discovery failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Publisher Validation: Validate a publisher's adagents.json (public version for members directory)
    this.app.get('/api/public/validate-publisher', async (req, res) => {
      const { domain } = req.query;

      if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'Domain is required' });
      }

      try {
        const result = await this.adagentsManager.validateDomain(domain);
        const stats = extractPublisherStats(result);

        return res.json({
          valid: result.valid,
          domain: result.domain,
          url: result.url,
          agent_count: stats.agentCount,
          property_count: stats.propertyCount,
          property_type_counts: stats.propertyTypeCounts,
          tag_count: stats.tagCount,
          errors: result.errors,
          warnings: result.warnings,
        });
      } catch (error) {
        logger.error({ err: error, domain }, 'Public publisher validation error');

        return res.status(500).json({
          error: 'Publisher validation failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // List all public publishers from member organizations (public endpoint for publishers registry)
    this.app.get('/api/public/publishers', async (req, res) => {
      try {
        const memberDb = new MemberDatabase();
        const members = await memberDb.getPublicProfiles({});

        // Collect all public publishers from members
        const publishers = members.flatMap((m) =>
          (m.publishers || [])
            .filter((p) => p.is_public)
            .map((p) => ({
              domain: p.domain,
              agent_count: p.agent_count,
              last_validated: p.last_validated,
              member: {
                slug: m.slug,
                display_name: m.display_name,
              },
            }))
        );

        return res.json({
          publishers,
          count: publishers.length,
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to list public publishers');
        return res.status(500).json({
          error: 'Failed to list publishers',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Publisher Validation: Validate a publisher's adagents.json (authenticated version with full details)
    this.app.get('/api/validate-publisher', requireAuth, async (req, res) => {
      const { domain } = req.query;

      if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'Domain is required' });
      }

      try {
        const result = await this.adagentsManager.validateDomain(domain);
        const stats = extractPublisherStats(result);

        return res.json({
          valid: result.valid,
          domain: result.domain,
          url: result.url,
          agent_count: stats.agentCount,
          property_count: stats.propertyCount,
          property_type_counts: stats.propertyTypeCounts,
          tag_count: stats.tagCount,
          errors: result.errors,
          warnings: result.warnings,
          authorized_agents: result.raw_data?.authorized_agents || [],
        });
      } catch (error) {
        logger.error({ err: error, domain }, 'Publisher validation error');

        return res.status(500).json({
          error: 'Publisher validation failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Global error handler - logger.error() automatically captures to PostHog via error hook
    this.app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(port: number = 3000): Promise<void> {
    // Initialize OpenTelemetry logging for PostHog (all log levels)
    const { initOtelLogs, emitLog } = await import('./utils/otel-logs.js');
    const { setLogHook } = await import('./logger.js');
    if (initOtelLogs()) {
      setLogHook(emitLog);
    }

    // Initialize PostHog error tracking (captures all logger.error() calls as exceptions)
    const { initPostHogErrorTracking } = await import('./utils/posthog.js');
    initPostHogErrorTracking();

    // Initialize database
    const { initializeDatabase } = await import("./db/client.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { getDatabaseConfig } = await import("./config.js");

    const dbConfig = getDatabaseConfig();
    if (!dbConfig) {
      throw new Error("DATABASE_URL or DATABASE_PRIVATE_URL environment variable is required");
    }
    initializeDatabase(dbConfig);
    await runMigrations();

    // Sync organizations from WorkOS and Stripe to local database (dev environment support)
    if (AUTH_ENABLED && workos) {
      const orgDb = new OrganizationDatabase();

      // Sync WorkOS organizations first
      try {
        const result = await orgDb.syncFromWorkOS(workos);
        if (result.synced > 0) {
          logger.info({ synced: result.synced, existing: result.existing }, 'Synced organizations from WorkOS');
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to sync organizations from WorkOS (non-fatal)');
      }

      // Then sync Stripe customer IDs
      try {
        const result = await orgDb.syncStripeCustomers();
        if (result.synced > 0) {
          logger.info({ synced: result.synced, skipped: result.skipped }, 'Synced Stripe customer IDs');
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to sync Stripe customers (non-fatal)');
      }

      // Seed dev organizations if dev mode is enabled
      if (isDevModeEnabled()) {
        try {
          await this.seedDevOrganizations(orgDb);
        } catch (error) {
          logger.warn({ error }, 'Failed to seed dev organizations (non-fatal)');
        }
      }
    }

    // Pre-warm caches for all agents in background
    const allAgents = await this.agentService.listAgents();
    logger.info({ agentCount: allAgents.length }, 'Pre-warming caches');

    // Don't await - let this run in background
    this.prewarmCaches(allAgents).then(() => {
      logger.info('Cache pre-warming complete');
    }).catch(err => {
      logger.error({ err }, 'Cache pre-warming failed');
    });

    // Start periodic property crawler for sales agents
    const salesAgents = await this.agentService.listAgents("sales");
    if (salesAgents.length > 0) {
      logger.info({ salesAgentCount: salesAgents.length }, 'Starting property crawler');
      this.crawler.startPeriodicCrawl(salesAgents, 60); // Crawl every 60 minutes
    }

    // Start periodic content curator for Addie's knowledge base
    // Process pending external resources (fetch content, generate summaries)
    this.startContentCurator();

    // Start industry feed monitoring
    // Fetches RSS feeds, processes articles, sends Slack alerts
    this.startIndustryMonitor();

    // Start daily task reminder job
    // Sends DMs to admins about overdue/upcoming tasks
    this.startTaskReminders();

    // Start engagement scoring job
    // Updates user and org engagement scores periodically
    this.startEngagementScoring();

    this.server = this.app.listen(port, () => {
      logger.info({
        port,
        webUi: `http://localhost:${port}`,
        api: `http://localhost:${port}/api/agents`,
      }, 'AdCP Registry HTTP server running');
    });

    // Setup graceful shutdown handlers
    this.setupShutdownHandlers();
  }

  /**
   * Start periodic content curator for Addie's knowledge base
   * Processes pending external resources (fetch content, generate AI summaries)
   */
  private startContentCurator(): void {
    const CURATOR_INTERVAL_MINUTES = 5;

    // Process on startup after a short delay
    setTimeout(async () => {
      try {
        // Process manually queued resources
        const result = await processPendingResources({ limit: 5 });
        if (result.processed > 0) {
          logger.info(result, 'Content curator: processed pending resources');
        }
        // Process RSS perspectives
        const rssResult = await processRssPerspectives({ limit: 5 });
        if (rssResult.processed > 0) {
          logger.info(rssResult, 'Content curator: processed RSS perspectives');
        }
        // Process community articles
        const communityResult = await processCommunityArticles({ limit: 5 });
        if (communityResult.processed > 0) {
          logger.info(communityResult, 'Content curator: processed community articles');
        }
        // Send replies to processed community articles
        const replyResult = await sendCommunityReplies(async (channelId, threadTs, text) => {
          const result = await sendChannelMessage(channelId, { text, thread_ts: threadTs });
          return result.ok;
        });
        if (replyResult.sent > 0) {
          logger.info(replyResult, 'Content curator: sent community article replies');
        }
      } catch (err) {
        logger.error({ err }, 'Content curator: initial processing failed');
      }
    }, 30000); // 30 second delay to let other services start

    // Then process periodically
    this.contentCuratorIntervalId = setInterval(async () => {
      try {
        // Process manually queued resources
        const result = await processPendingResources({ limit: 5 });
        if (result.processed > 0) {
          logger.info(result, 'Content curator: processed pending resources');
        }
        // Process RSS perspectives
        const rssResult = await processRssPerspectives({ limit: 5 });
        if (rssResult.processed > 0) {
          logger.info(rssResult, 'Content curator: processed RSS perspectives');
        }
        // Process community articles
        const communityResult = await processCommunityArticles({ limit: 5 });
        if (communityResult.processed > 0) {
          logger.info(communityResult, 'Content curator: processed community articles');
        }
        // Send replies to processed community articles
        const replyResult = await sendCommunityReplies(async (channelId, threadTs, text) => {
          const result = await sendChannelMessage(channelId, { text, thread_ts: threadTs });
          return result.ok;
        });
        if (replyResult.sent > 0) {
          logger.info(replyResult, 'Content curator: sent community article replies');
        }
      } catch (err) {
        logger.error({ err }, 'Content curator: periodic processing failed');
      }
    }, CURATOR_INTERVAL_MINUTES * 60 * 1000);

    logger.info({ intervalMinutes: CURATOR_INTERVAL_MINUTES }, 'Content curator started');
  }

  /**
   * Start industry feed monitoring system
   * Fetches RSS feeds from ad tech publications, processes articles,
   * and sends Slack alerts for high-priority content
   */
  private startIndustryMonitor(): void {
    const FEED_FETCH_INTERVAL_MINUTES = 30;
    const ALERT_CHECK_INTERVAL_MINUTES = 5;

    // Feed fetcher - check feeds every 30 minutes
    // Creates perspectives from RSS articles, which are then processed by the content curator
    this.feedFetcherInitialTimeoutId = setTimeout(async () => {
      this.feedFetcherInitialTimeoutId = null;
      try {
        const result = await processFeedsToFetch();
        if (result.feedsProcessed > 0) {
          logger.info(result, 'Industry monitor: fetched RSS feeds');
        }
      } catch (err) {
        logger.error({ err }, 'Industry monitor: initial feed fetch failed');
      }
    }, 60000); // 1 minute delay to let other services start

    this.feedFetcherIntervalId = setInterval(async () => {
      try {
        const result = await processFeedsToFetch();
        if (result.feedsProcessed > 0) {
          logger.info(result, 'Industry monitor: fetched RSS feeds');
        }
      } catch (err) {
        logger.error({ err }, 'Industry monitor: periodic feed fetch failed');
      }
    }, FEED_FETCH_INTERVAL_MINUTES * 60 * 1000);

    // Alert processor - check for alerts every 5 minutes
    this.alertProcessorInitialTimeoutId = setTimeout(async () => {
      this.alertProcessorInitialTimeoutId = null;
      try {
        const result = await processAlerts();
        if (result.alerted > 0) {
          logger.info(result, 'Industry monitor: sent alerts');
        }
      } catch (err) {
        logger.error({ err }, 'Industry monitor: initial alert processing failed');
      }
    }, 120000); // 2 minute delay

    this.alertProcessorIntervalId = setInterval(async () => {
      try {
        const result = await processAlerts();
        if (result.alerted > 0) {
          logger.info(result, 'Industry monitor: sent alerts');
        }
      } catch (err) {
        logger.error({ err }, 'Industry monitor: periodic alert processing failed');
      }
    }, ALERT_CHECK_INTERVAL_MINUTES * 60 * 1000);

    logger.info({
      feedFetchIntervalMinutes: FEED_FETCH_INTERVAL_MINUTES,
      alertCheckIntervalMinutes: ALERT_CHECK_INTERVAL_MINUTES,
    }, 'Industry monitor started');
  }

  /**
   * Start daily task reminder job
   * Sends DMs to admins about overdue/upcoming tasks at 9am ET
   */
  private startTaskReminders(): void {
    const REMINDER_CHECK_INTERVAL_HOURS = 1;

    // Check every hour, but only send once per day per user
    this.taskReminderIntervalId = setInterval(async () => {
      try {
        // Only run during morning hours (8-10am ET) using proper timezone handling
        const now = new Date();
        const etHour = parseInt(now.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          hour12: false,
        }), 10);
        if (etHour < 8 || etHour > 10) {
          return;
        }

        // Skip weekends (using ET day of week)
        const etDayStr = now.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
        });
        if (etDayStr === 'Sat' || etDayStr === 'Sun') {
          return;
        }

        const result = await runTaskReminderJob();
        if (result.remindersSent > 0) {
          logger.info(result, 'Task reminders: sent daily reminders');
        }
      } catch (err) {
        logger.error({ err }, 'Task reminders: job failed');
      }
    }, REMINDER_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);

    logger.info({ intervalHours: REMINDER_CHECK_INTERVAL_HOURS }, 'Task reminder job started');
  }

  /**
   * Start periodic engagement scoring for users and organizations
   * Updates stale scores (older than 1 day) every hour
   */
  private startEngagementScoring(): void {
    const SCORING_INTERVAL_HOURS = 1;

    // Run immediately on startup (with delay for DB connection)
    setTimeout(async () => {
      try {
        await runEngagementScoringJob();
      } catch (err) {
        logger.error({ err }, 'Engagement scoring: initial batch failed');
      }
    }, 10000);

    // Then run periodically
    this.engagementScoringIntervalId = setInterval(async () => {
      try {
        await runEngagementScoringJob();
      } catch (err) {
        logger.error({ err }, 'Engagement scoring: job failed');
      }
    }, SCORING_INTERVAL_HOURS * 60 * 60 * 1000);

    logger.info({ intervalHours: SCORING_INTERVAL_HOURS }, 'Engagement scoring job started');
  }

  /**
   * Setup graceful shutdown handlers for SIGTERM and SIGINT
   */
  private setupShutdownHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping HTTP server');

    // Stop content curator
    if (this.contentCuratorIntervalId) {
      clearInterval(this.contentCuratorIntervalId);
      this.contentCuratorIntervalId = null;
      logger.info('Content curator stopped');
    }

    // Stop industry monitor jobs
    if (this.feedFetcherInitialTimeoutId) {
      clearTimeout(this.feedFetcherInitialTimeoutId);
      this.feedFetcherInitialTimeoutId = null;
    }
    if (this.feedFetcherIntervalId) {
      clearInterval(this.feedFetcherIntervalId);
      this.feedFetcherIntervalId = null;
    }
    if (this.alertProcessorInitialTimeoutId) {
      clearTimeout(this.alertProcessorInitialTimeoutId);
      this.alertProcessorInitialTimeoutId = null;
    }
    if (this.alertProcessorIntervalId) {
      clearInterval(this.alertProcessorIntervalId);
      this.alertProcessorIntervalId = null;
    }
    logger.info('Industry monitor stopped');

    // Stop task reminder job
    if (this.taskReminderIntervalId) {
      clearInterval(this.taskReminderIntervalId);
      this.taskReminderIntervalId = null;
      logger.info('Task reminder job stopped');
    }

    // Stop engagement scoring job
    if (this.engagementScoringIntervalId) {
      clearInterval(this.engagementScoringIntervalId);
      this.engagementScoringIntervalId = null;
      logger.info('Engagement scoring job stopped');
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) {
            logger.error({ err }, "Error closing HTTP server");
            reject(err);
          } else {
            logger.info("HTTP server closed");
            resolve();
          }
        });
      });
    }

    // Shutdown PostHog client (flush pending events)
    const { shutdownPostHog } = await import('./utils/posthog.js');
    await shutdownPostHog();

    // Shutdown OpenTelemetry logging (flush pending logs)
    const { shutdownOtelLogs } = await import('./utils/otel-logs.js');
    await shutdownOtelLogs();

    // Close database connection
    logger.info('Closing database connection');
    await closeDatabase();
    logger.info('Database connection closed');

    logger.info('Graceful shutdown complete');
  }

  /**
   * Seed dev organizations in the database
   * Creates organizations for dev users so they can access dashboard without onboarding
   */
  private async seedDevOrganizations(orgDb: OrganizationDatabase): Promise<void> {
    const devOrgs = [
      {
        id: 'org_dev_company_001',
        name: 'Dev Company (Member)',
        is_personal: false,
        company_type: 'brand' as const,
        revenue_tier: '5m_50m' as const,
      },
      {
        id: 'org_dev_personal_001',
        name: 'Dev Personal Workspace',
        is_personal: true,
        company_type: null,
        revenue_tier: null,
      },
    ];

    for (const devOrg of devOrgs) {
      try {
        // Check if org already exists
        const existing = await orgDb.getOrganization(devOrg.id);
        if (!existing) {
          await orgDb.createOrganization({
            workos_organization_id: devOrg.id,
            name: devOrg.name,
            is_personal: devOrg.is_personal,
            company_type: devOrg.company_type || undefined,
            revenue_tier: devOrg.revenue_tier || undefined,
          });
          logger.info({ orgId: devOrg.id, name: devOrg.name }, 'Created dev organization');
        }
      } catch (error) {
        // Ignore duplicate key errors (org already exists)
        if (error instanceof Error && error.message.includes('duplicate key')) {
          logger.debug({ orgId: devOrg.id }, 'Dev organization already exists');
        } else {
          throw error;
        }
      }
    }
  }

  private async prewarmCaches(agents: any[]): Promise<void> {
    await Promise.all(
      agents.map(async (agent) => {
        try {
          // Warm health and stats caches
          await Promise.all([
            this.healthChecker.checkHealth(agent),
            this.healthChecker.getStats(agent),
            this.capabilityDiscovery.discoverCapabilities(agent),
          ]);

          // Warm type-specific caches
          if (agent.type === "sales") {
            await this.propertiesService.getPropertiesForAgent(agent);
          }
        } catch (error) {
          // Errors are expected for offline agents, just continue
        }
      })
    );
  }
}

