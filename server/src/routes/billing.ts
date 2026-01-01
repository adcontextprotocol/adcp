/**
 * Billing routes module
 *
 * This module contains billing-related admin routes extracted from http.ts.
 * Includes product management, Stripe customer management, and invoice handling.
 */

import { Router } from "express";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { getPool } from "../db/client.js";
import {
  stripe,
  getBillingProducts,
  createProduct,
  updateProductMetadata,
  archiveProduct,
  clearProductsCache,
  getPendingInvoices,
  voidInvoice,
  deleteDraftInvoice,
  type CreateProductInput,
  type UpdateProductInput,
  type PendingInvoice,
} from "../billing/stripe-client.js";

const logger = createLogger("billing-routes");

/**
 * Create billing routes
 * Returns separate routers for page routes (/admin/*) and API routes (/api/admin/*)
 */
export function createBillingRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  pageRouter.get("/products", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-products.html").catch((err) => {
      logger.error({ err }, "Error serving admin products page");
      res.status(500).send("Internal server error");
    });
  });

  pageRouter.get("/billing", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-billing.html").catch((err) => {
      logger.error({ err }, "Error serving admin billing page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // BILLING PRODUCTS API (mounted at /api/admin)
  // =========================================================================

  // GET /api/admin/products - List all billing products
  apiRouter.get("/products", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const products = await getBillingProducts();
      res.json({ products });
    } catch (error) {
      logger.error({ err: error }, "Error fetching admin products");
      res.status(500).json({
        error: "Failed to fetch products",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // POST /api/admin/products - Create a new product
  apiRouter.post("/products", requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        name,
        description,
        lookupKey,
        amountCents,
        currency,
        billingType,
        billingInterval,
        category,
        displayName,
        customerTypes,
        revenueTiers,
        invoiceable,
        sortOrder,
      } = req.body as CreateProductInput;

      // Validate required fields
      if (!name || !lookupKey || !amountCents || !billingType || !category) {
        return res.status(400).json({
          error: "Missing required fields",
          message: "name, lookupKey, amountCents, billingType, and category are required",
        });
      }

      // Validate lookup key format
      if (!lookupKey.startsWith("aao_")) {
        return res.status(400).json({
          error: "Invalid lookup key",
          message: 'Lookup key must start with "aao_"',
        });
      }

      // Validate billing type
      if (!["subscription", "one_time"].includes(billingType)) {
        return res.status(400).json({
          error: "Invalid billing type",
          message: 'Billing type must be "subscription" or "one_time"',
        });
      }

      // Validate category
      const validCategories = ["membership", "sponsorship", "event", "other"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          error: "Invalid category",
          message: `Category must be one of: ${validCategories.join(", ")}`,
        });
      }

      const product = await createProduct({
        name,
        description,
        lookupKey,
        amountCents,
        currency,
        billingType,
        billingInterval,
        category,
        displayName,
        customerTypes,
        revenueTiers,
        invoiceable,
        sortOrder,
      });

      if (!product) {
        return res.status(500).json({
          error: "Failed to create product",
          message: "Stripe may not be configured",
        });
      }

      // Clear cache so the new product appears immediately
      clearProductsCache();

      logger.info(
        {
          productId: product.product_id,
          priceId: product.price_id,
          lookupKey: product.lookup_key,
          adminEmail: req.user!.email,
        },
        "Admin created product"
      );

      res.json({ success: true, product });
    } catch (error) {
      logger.error({ err: error }, "Error creating product");
      res.status(500).json({
        error: "Failed to create product",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // PUT /api/admin/products/:productId - Update a product
  apiRouter.put("/products/:productId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { productId } = req.params;
      const {
        priceId,
        name,
        description,
        displayName,
        category,
        customerTypes,
        revenueTiers,
        invoiceable,
        sortOrder,
      } = req.body as UpdateProductInput;

      if (!priceId) {
        return res.status(400).json({
          error: "Missing required field",
          message: "priceId is required",
        });
      }

      const product = await updateProductMetadata({
        productId,
        priceId,
        name,
        description,
        displayName,
        category,
        customerTypes,
        revenueTiers,
        invoiceable,
        sortOrder,
      });

      if (!product) {
        return res.status(500).json({
          error: "Failed to update product",
          message: "Stripe may not be configured",
        });
      }

      // Clear cache so updates appear immediately
      clearProductsCache();

      logger.info(
        {
          productId,
          priceId,
          adminEmail: req.user!.email,
        },
        "Admin updated product"
      );

      res.json({ success: true, product });
    } catch (error) {
      logger.error({ err: error, productId: req.params.productId }, "Error updating product");
      res.status(500).json({
        error: "Failed to update product",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // DELETE /api/admin/products/:productId - Archive a product
  apiRouter.delete("/products/:productId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { productId } = req.params;
      const { priceId } = req.body as { priceId: string };

      if (!priceId) {
        return res.status(400).json({
          error: "Missing required field",
          message: "priceId is required in request body",
        });
      }

      const success = await archiveProduct(productId, priceId);

      if (!success) {
        return res.status(500).json({
          error: "Failed to archive product",
          message: "Stripe may not be configured",
        });
      }

      // Clear cache so archived product disappears immediately
      clearProductsCache();

      logger.info(
        {
          productId,
          priceId,
          adminEmail: req.user!.email,
        },
        "Admin archived product"
      );

      res.json({ success: true, message: "Product archived" });
    } catch (error) {
      logger.error({ err: error, productId: req.params.productId }, "Error archiving product");
      res.status(500).json({
        error: "Failed to archive product",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // =========================================================================
  // INVOICE MANAGEMENT API (mounted at /api/admin)
  // =========================================================================

  // GET /api/admin/invoices/pending/:customerId - Get pending invoices for a customer
  apiRouter.get("/invoices/pending/:customerId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { customerId } = req.params;

      if (!customerId) {
        return res.status(400).json({
          error: "Missing required field",
          message: "customerId is required",
        });
      }

      const invoices = await getPendingInvoices(customerId);

      logger.info(
        {
          customerId,
          invoiceCount: invoices.length,
          adminEmail: req.user!.email,
        },
        "Admin fetched pending invoices"
      );

      res.json({ invoices });
    } catch (error) {
      logger.error({ err: error, customerId: req.params.customerId }, "Error fetching pending invoices");
      res.status(500).json({
        error: "Failed to fetch pending invoices",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // POST /api/admin/invoices/:invoiceId/void - Void an open invoice
  apiRouter.post("/invoices/:invoiceId/void", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { invoiceId } = req.params;

      if (!invoiceId) {
        return res.status(400).json({
          error: "Missing required field",
          message: "invoiceId is required",
        });
      }

      const success = await voidInvoice(invoiceId);

      if (!success) {
        return res.status(500).json({
          error: "Failed to void invoice",
          message: "Stripe may not be configured or invoice cannot be voided",
        });
      }

      logger.info(
        {
          invoiceId,
          adminEmail: req.user!.email,
        },
        "Admin voided invoice"
      );

      res.json({ success: true, message: "Invoice voided" });
    } catch (error) {
      logger.error({ err: error, invoiceId: req.params.invoiceId }, "Error voiding invoice");
      res.status(500).json({
        error: "Failed to void invoice",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // DELETE /api/admin/invoices/:invoiceId - Delete a draft invoice
  apiRouter.delete("/invoices/:invoiceId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { invoiceId } = req.params;

      if (!invoiceId) {
        return res.status(400).json({
          error: "Missing required field",
          message: "invoiceId is required",
        });
      }

      const success = await deleteDraftInvoice(invoiceId);

      if (!success) {
        return res.status(500).json({
          error: "Failed to delete invoice",
          message: "Stripe may not be configured or invoice is not a draft",
        });
      }

      logger.info(
        {
          invoiceId,
          adminEmail: req.user!.email,
        },
        "Admin deleted draft invoice"
      );

      res.json({ success: true, message: "Draft invoice deleted" });
    } catch (error) {
      logger.error({ err: error, invoiceId: req.params.invoiceId }, "Error deleting draft invoice");
      res.status(500).json({
        error: "Failed to delete invoice",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // =========================================================================
  // STRIPE CUSTOMER MANAGEMENT API (mounted at /api/admin)
  // =========================================================================

  // GET /api/admin/stripe-customers - List all Stripe customers with link status and payment totals
  apiRouter.get("/stripe-customers", requireAuth, requireAdmin, async (req, res) => {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe not configured" });
    }

    try {
      const pool = getPool();

      // Get all orgs with stripe_customer_id
      const orgsResult = await pool.query(`
        SELECT workos_organization_id, name, stripe_customer_id
        FROM organizations
        WHERE stripe_customer_id IS NOT NULL
      `);
      const customerToOrg = new Map(
        orgsResult.rows.map((o) => [o.stripe_customer_id, { id: o.workos_organization_id, name: o.name }])
      );

      // Fetch all Stripe customers with their payment totals
      const customers: Array<{
        id: string;
        name: string | null;
        email: string | null;
        created: number;
        total_paid: number;
        invoice_count: number;
        open_invoice_count: number;
        open_invoice_total: number;
        linked_org: { id: string; name: string } | null;
        has_payment_method: boolean;
        active_subscriptions: number;
        currency: string | null;
      }> = [];

      for await (const customer of stripe.customers.list({ limit: 100, expand: ["data.subscriptions"] })) {
        // Get paid invoices for this customer to calculate total paid
        let totalPaid = 0;
        let invoiceCount = 0;

        for await (const invoice of stripe.invoices.list({
          customer: customer.id,
          status: "paid",
          limit: 100,
        })) {
          totalPaid += invoice.amount_paid;
          invoiceCount++;
        }

        // Get open invoices
        let openInvoiceCount = 0;
        let openInvoiceTotal = 0;

        for await (const invoice of stripe.invoices.list({
          customer: customer.id,
          status: "open",
          limit: 100,
        })) {
          openInvoiceCount++;
          openInvoiceTotal += invoice.amount_due;
        }

        // Count active subscriptions
        const activeSubscriptions =
          customer.subscriptions?.data.filter((s) => s.status === "active" || s.status === "trialing").length ?? 0;

        customers.push({
          id: customer.id,
          name: customer.name ?? null,
          email: customer.email ?? null,
          created: customer.created,
          total_paid: totalPaid,
          invoice_count: invoiceCount,
          open_invoice_count: openInvoiceCount,
          open_invoice_total: openInvoiceTotal,
          linked_org: customerToOrg.get(customer.id) || null,
          has_payment_method: !!customer.default_source || !!customer.invoice_settings?.default_payment_method,
          active_subscriptions: activeSubscriptions,
          currency: customer.currency ?? null,
        });
      }

      // Sort: unlinked with payments first, then by total_paid descending
      customers.sort((a, b) => {
        // Unlinked customers with payments come first
        const aUnlinkedWithPayments = !a.linked_org && a.total_paid > 0;
        const bUnlinkedWithPayments = !b.linked_org && b.total_paid > 0;
        if (aUnlinkedWithPayments && !bUnlinkedWithPayments) return -1;
        if (!aUnlinkedWithPayments && bUnlinkedWithPayments) return 1;
        // Then by total paid descending
        return b.total_paid - a.total_paid;
      });

      const unlinkedCount = customers.filter((c) => !c.linked_org).length;
      const unlinkedWithPayments = customers.filter((c) => !c.linked_org && c.total_paid > 0).length;

      res.json({
        customers,
        total: customers.length,
        linked: customers.length - unlinkedCount,
        unlinked: unlinkedCount,
        unlinked_with_payments: unlinkedWithPayments,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching Stripe customers");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to fetch customers",
      });
    }
  });

  // POST /api/admin/stripe-customers/:customerId/link - Manually link a Stripe customer to an org
  apiRouter.post("/stripe-customers/:customerId/link", requireAuth, requireAdmin, async (req, res) => {
    const { customerId } = req.params;
    const { org_id } = req.body;

    if (!customerId || !customerId.startsWith("cus_")) {
      return res.status(400).json({ error: "Invalid customer ID format" });
    }

    if (!org_id) {
      return res.status(400).json({ error: "org_id is required" });
    }

    try {
      const pool = getPool();

      // Verify org exists
      const orgResult = await pool.query(
        "SELECT workos_organization_id, name, stripe_customer_id FROM organizations WHERE workos_organization_id = $1",
        [org_id]
      );

      if (orgResult.rows.length === 0) {
        return res.status(404).json({ error: "Organization not found" });
      }

      const org = orgResult.rows[0];

      if (org.stripe_customer_id && org.stripe_customer_id !== customerId) {
        return res.status(400).json({
          error: "Organization already linked",
          message: `This organization is already linked to a different Stripe customer (${org.stripe_customer_id})`,
        });
      }

      // Check if customer is already linked to another org
      const existingLink = await pool.query(
        "SELECT workos_organization_id, name FROM organizations WHERE stripe_customer_id = $1",
        [customerId]
      );

      if (existingLink.rows.length > 0 && existingLink.rows[0].workos_organization_id !== org_id) {
        return res.status(400).json({
          error: "Customer already linked",
          message: `This Stripe customer is already linked to "${existingLink.rows[0].name}"`,
        });
      }

      // Link the customer
      await pool.query("UPDATE organizations SET stripe_customer_id = $1 WHERE workos_organization_id = $2", [
        customerId,
        org_id,
      ]);

      logger.info(
        { customerId, orgId: org_id, orgName: org.name, adminEmail: req.user?.email },
        "Manually linked Stripe customer to org"
      );

      res.json({
        success: true,
        message: `Linked Stripe customer ${customerId} to "${org.name}"`,
        customer_id: customerId,
        org_id,
        org_name: org.name,
      });
    } catch (error) {
      logger.error({ err: error, customerId, org_id }, "Error linking Stripe customer");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to link customer",
      });
    }
  });

  // POST /api/admin/stripe-customers/:customerId/unlink - Unlink a Stripe customer from its org
  apiRouter.post("/stripe-customers/:customerId/unlink", requireAuth, requireAdmin, async (req, res) => {
    const { customerId } = req.params;

    if (!customerId || !customerId.startsWith("cus_")) {
      return res.status(400).json({ error: "Invalid customer ID format" });
    }

    try {
      const pool = getPool();

      // Find the org linked to this customer
      const linkedOrg = await pool.query(
        "SELECT workos_organization_id, name FROM organizations WHERE stripe_customer_id = $1",
        [customerId]
      );

      if (linkedOrg.rows.length === 0) {
        return res.status(404).json({ error: "Customer is not linked to any organization" });
      }

      const org = linkedOrg.rows[0];

      // Unlink the customer
      await pool.query("UPDATE organizations SET stripe_customer_id = NULL WHERE stripe_customer_id = $1", [customerId]);

      logger.info(
        { customerId, orgId: org.workos_organization_id, orgName: org.name, adminEmail: req.user?.email },
        "Unlinked Stripe customer from org"
      );

      res.json({
        success: true,
        message: `Unlinked Stripe customer ${customerId} from "${org.name}"`,
        customer_id: customerId,
        org_id: org.workos_organization_id,
        org_name: org.name,
      });
    } catch (error) {
      logger.error({ err: error, customerId }, "Error unlinking Stripe customer");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to unlink customer",
      });
    }
  });

  // GET /api/admin/org-search - Search organizations for linking
  apiRouter.get("/org-search", requireAuth, requireAdmin, async (req, res) => {
    const query = req.query.q as string;

    if (!query || query.length < 2) {
      return res.json({ organizations: [] });
    }

    try {
      const pool = getPool();
      // Escape LIKE special characters to prevent pattern injection
      const escapedQuery = query.replace(/[%_\\]/g, "\\$&");
      const result = await pool.query(
        `
        SELECT workos_organization_id, name, email_domain, stripe_customer_id
        FROM organizations
        WHERE is_personal = false
          AND (name ILIKE $1 OR email_domain ILIKE $1)
        ORDER BY name
        LIMIT 20
      `,
        [`%${escapedQuery}%`]
      );

      res.json({ organizations: result.rows });
    } catch (error) {
      logger.error({ err: error }, "Error searching organizations");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to search organizations",
      });
    }
  });

  // DELETE /api/admin/stripe-customers/:customerId - Delete an unlinked Stripe customer
  apiRouter.delete("/stripe-customers/:customerId", requireAuth, requireAdmin, async (req, res) => {
    const { customerId } = req.params;

    if (!customerId || !customerId.startsWith("cus_")) {
      return res.status(400).json({ error: "Invalid customer ID format" });
    }

    if (!stripe) {
      return res.status(400).json({ error: "Stripe not configured" });
    }

    try {
      const pool = getPool();

      // Check if customer is linked to any org
      const linkedOrg = await pool.query(
        "SELECT workos_organization_id, name FROM organizations WHERE stripe_customer_id = $1",
        [customerId]
      );

      if (linkedOrg.rows.length > 0) {
        return res.status(400).json({
          error: "Cannot delete linked customer",
          message: `This customer is linked to "${linkedOrg.rows[0].name}". Unlink it first.`,
        });
      }

      // Fetch customer to check for subscriptions and invoices
      const customer = await stripe.customers.retrieve(customerId, {
        expand: ["subscriptions"],
      });

      if (customer.deleted) {
        return res.status(404).json({ error: "Customer already deleted" });
      }

      // Check for active subscriptions
      if (customer.subscriptions && customer.subscriptions.data.length > 0) {
        const activeSubscriptions = customer.subscriptions.data.filter(
          (s) => s.status === "active" || s.status === "trialing"
        );
        if (activeSubscriptions.length > 0) {
          return res.status(400).json({
            error: "Cannot delete customer with active subscriptions",
            message: `This customer has ${activeSubscriptions.length} active subscription(s). Cancel them in Stripe first.`,
          });
        }
      }

      // Delete the customer in Stripe
      await stripe.customers.del(customerId);

      logger.info({ customerId, adminEmail: req.user?.email }, "Deleted Stripe customer");

      res.json({
        success: true,
        message: `Deleted Stripe customer ${customerId}`,
        customer_id: customerId,
      });
    } catch (error) {
      logger.error({ err: error, customerId }, "Error deleting Stripe customer");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to delete customer",
      });
    }
  });

  return { pageRouter, apiRouter };
}
