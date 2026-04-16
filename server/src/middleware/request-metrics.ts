/**
 * Request metrics middleware.
 *
 * Captures timing and status for every /api/* request and sends a PostHog
 * event so we can build dashboards for latency percentiles, throughput,
 * and error rates per endpoint.
 *
 * Lightweight: one PostHog capture per request (batched by the SDK).
 */

import { Request, Response, NextFunction } from "express";
import { captureEvent } from "../utils/posthog.js";

/** Collapse UUIDs and numeric path segments so metrics aggregate cleanly. */
function normalizeRoute(method: string, path: string): string {
  return `${method} ${path
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ":id"
    )
    .replace(/\/\d+\b/g, "/:n")}`;
}

/**
 * Express middleware — mount before routes.
 * Only tracks /api/* paths to keep event volume manageable.
 */
export function requestMetrics(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = normalizeRoute(req.method, req.path.slice(0, 200));

    captureEvent("server-metrics", "api_request", {
      route,
      method: req.method,
      path: req.path.slice(0, 200),
      status: res.statusCode,
      duration_ms: Math.round(durationMs),
      ok: res.statusCode < 400,
    });
  });

  next();
}
