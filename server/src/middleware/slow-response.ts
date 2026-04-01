/**
 * Slow API response detection middleware.
 *
 * Measures response time for /api/* routes. Logs warnings for slow responses
 * and sends Slack alerts for very slow ones (likely external service hangs).
 *
 * Thresholds:
 *  - >3s: logger.warn (shows in logs + PostHog via error tracking hook)
 *  - >10s: Slack alert to ops channel
 */

import { Request, Response, NextFunction } from "express";
import { sendChannelMessage, isSlackConfigured } from "../slack/client.js";
import { createLogger } from "../logger.js";

const logger = createLogger("slow-response");

const WARN_THRESHOLD_MS = 3_000;
const ALERT_THRESHOLD_MS = 10_000;
const OPS_ALERT_CHANNEL_ID = process.env.OPS_ALERT_CHANNEL_ID;

// Rate limit Slack alerts: max 1 per endpoint per 5 minutes
const alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_ENTRIES = 500;

/** Collapse UUIDs and numeric IDs so distinct paths share a cooldown key. */
function normalizeAlertKey(method: string, path: string): string {
  return `${method}:${path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+\b/g, "/:n")}`;
}

function shouldAlert(key: string): boolean {
  const now = Date.now();
  const last = alertCooldowns.get(key);
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  alertCooldowns.set(key, now);
  if (alertCooldowns.size > MAX_COOLDOWN_ENTRIES) {
    const cutoff = now - ALERT_COOLDOWN_MS;
    for (const [k, t] of alertCooldowns) {
      if (t < cutoff) alertCooldowns.delete(k);
    }
  }
  return true;
}

function notifySlack(method: string, path: string, durationMs: number, status: number): void {
  if (!OPS_ALERT_CHANNEL_ID || !isSlackConfigured()) return;

  const safePath = path.slice(0, 200).replace(/[`*_~<>]/g, "");
  const seconds = (durationMs / 1000).toFixed(1);

  sendChannelMessage(OPS_ALERT_CHANNEL_ID, {
    text: `Slow API: ${method} ${safePath} took ${seconds}s (status ${status})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `:snail: *Slow API response* on \`${process.env.FLY_APP_NAME || "aao-server"}\``,
            `*Endpoint:* \`${method} ${safePath}\``,
            `*Duration:* ${seconds}s`,
            `*Status:* ${status}`,
            "_This usually means an external service (Stripe, WorkOS) is slow or hanging._",
          ].join("\n"),
        },
      },
    ],
  }).catch(() => {});
}

/**
 * Express middleware — mount before routes.
 * Only tracks /api/* paths to avoid noise from static assets.
 */
export function slowResponseTracker(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    if (durationMs > WARN_THRESHOLD_MS) {
      logger.warn(
        {
          method: req.method,
          path: req.path.slice(0, 200),
          status: res.statusCode,
          duration_ms: Math.round(durationMs),
        },
        "Slow API response"
      );

      if (durationMs > ALERT_THRESHOLD_MS && shouldAlert(normalizeAlertKey(req.method, req.path))) {
        notifySlack(req.method, req.path, durationMs, res.statusCode);
      }
    }
  });

  next();
}
