/**
 * Prospect route compatibility layer
 *
 * All prospect operations have moved to accounts.ts under /api/admin/accounts/*.
 * These routes redirect requests from the old /api/admin/prospects/* paths so that
 * existing HTML pages (referrals, domain-health, data-cleanup, account-detail)
 * continue to work until they are updated to use the new paths.
 *
 * Uses 307/308 redirects to preserve HTTP method and request body.
 */

import { Router } from "express";

export function setupProspectRoutes(apiRouter: Router, _config: { workos: any }): void {

  // POST /api/admin/prospects → POST /api/admin/accounts
  apiRouter.post("/prospects", (req, res) => {
    res.redirect(308, "/api/admin/accounts");
  });

  // PUT /api/admin/prospects/:orgId → PUT /api/admin/accounts/:orgId
  apiRouter.put("/prospects/:orgId", (req, res) => {
    res.redirect(308, `/api/admin/accounts/${req.params.orgId}`);
  });

  // POST /api/admin/prospects/:orgId/payment-link → POST /api/admin/accounts/:orgId/payment-link
  apiRouter.post("/prospects/:orgId/payment-link", (req, res) => {
    res.redirect(308, `/api/admin/accounts/${req.params.orgId}/payment-link`);
  });

  // POST /api/admin/prospects/:orgId/invoice → POST /api/admin/accounts/:orgId/invoice
  apiRouter.post("/prospects/:orgId/invoice", (req, res) => {
    res.redirect(308, `/api/admin/accounts/${req.params.orgId}/invoice`);
  });

  // GET /api/admin/prospects/typeahead?q=... → GET /api/admin/accounts?view=all&search=...&limit=10
  apiRouter.get("/prospects/typeahead", (req, res) => {
    const q = req.query.q as string || "";
    res.redirect(307, `/api/admin/accounts?view=all&search=${encodeURIComponent(q)}&limit=10`);
  });
}
