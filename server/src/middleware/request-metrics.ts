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
import {
  observeLinkedCredentialOrganizationAuthorization,
  organizationSelectorFromRequest,
} from "./organization-authorization-observer.js";

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
    const selector = organizationSelectorFromRequest(req);
    const linkedCredential = Boolean(req.user?.authWorkosUserId);

    captureEvent("server-metrics", "api_request", {
      route,
      method: req.method,
      path: req.path.slice(0, 200),
      status: res.statusCode,
      duration_ms: Math.round(durationMs),
      ok: res.statusCode < 400,
      linked_credential: linkedCredential,
      explicit_organization: selector.explicit,
      organization_selector_source: selector.source,
    });

    // Run after the response and never await it on the request path. The
    // observer is telemetry-only and cannot change the served decision.
    void observeLinkedCredentialOrganizationAuthorization(req, route, res.statusCode);
  });

  next();
}
