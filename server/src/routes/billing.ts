/**
 * Billing routes module
 *
 * This module contains billing-related admin routes extracted from http.ts.
 * Includes product management for Stripe billing products.
 */

import { Router } from "express";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import {
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

  return { pageRouter, apiRouter };
}
