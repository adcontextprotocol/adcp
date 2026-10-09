import type Stripe from "stripe";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import { stripe } from "./stripe-client.js";

const logger = createLogger("invoice-cache");

/**
 * Refresh the local invoice cache for one Stripe customer.
 *
 * Stripe remains the source of truth. The upsert is idempotent and never
 * changes an invoice in Stripe.
 */
export async function syncInvoicesForCustomer(
  customerId: string,
  workosOrgId: string,
  stripeClient: Stripe | null = stripe,
  options: { throwOnError?: boolean } = {},
): Promise<number> {
  if (!stripeClient) {
    logger.warn("Stripe not initialized - cannot sync invoices");
    return 0;
  }

  const pool = getPool();
  let syncedCount = 0;

  try {
    const invoices = await stripeClient.invoices.list({
      customer: customerId,
      limit: 100,
    });

    for (const invoice of invoices.data) {
      let productName: string | null = null;
      if (invoice.lines?.data && invoice.lines.data.length > 0) {
        const primaryLine = invoice.lines.data[0] as any;
        const productId = primaryLine.price?.product as string;
        if (productId) {
          try {
            const product = await stripeClient.products.retrieve(productId);
            productName = product.name;
          } catch {
            productName = primaryLine.description || null;
          }
        }
      }

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
          workos_organization_id = EXCLUDED.workos_organization_id,
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
          customerId,
          workosOrgId,
          invoice.status,
          invoice.amount_due,
          invoice.amount_paid,
          invoice.currency,
          invoice.number || null,
          invoice.hosted_invoice_url || null,
          invoice.invoice_pdf || null,
          productName,
          typeof invoice.customer_email === "string" ? invoice.customer_email : null,
          new Date(invoice.created * 1000),
          invoice.due_date ? new Date(invoice.due_date * 1000) : null,
          invoice.status === "paid" && invoice.status_transitions?.paid_at
            ? new Date(invoice.status_transitions.paid_at * 1000)
            : null,
          invoice.status === "void" ? new Date() : null,
        ],
      );
      syncedCount++;
    }

    logger.info({ customerId, workosOrgId, syncedCount }, "Synced invoices for customer");
    return syncedCount;
  } catch (err) {
    const providerError = err as { code?: string; statusCode?: number; name?: string };
    logger.error(
      {
        customerId,
        workosOrgId,
        errorName: providerError.name,
        stripeCode: providerError.code,
        stripeStatusCode: providerError.statusCode,
      },
      "Failed to sync invoices for customer",
    );
    if (options.throwOnError) throw new Error("Invoice cache refresh failed");
    return syncedCount;
  }
}
