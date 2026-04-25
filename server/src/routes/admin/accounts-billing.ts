/**
 * Admin account billing routes
 *
 * Billing and lifecycle actions for accounts:
 * - Sync organization data from WorkOS and Stripe
 * - Get payment history
 * - Delete workspace (only when no payment history or active subscription)
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import Stripe from "stripe";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { stripe } from "../../billing/stripe-client.js";

const logger = createLogger("admin-accounts-billing");

interface AccountsBillingRoutesConfig {
  workos: WorkOS | null;
}

export function setupAccountsBillingRoutes(
  apiRouter: Router,
  config: AccountsBillingRoutesConfig
): void {
  const { workos } = config;

  // POST /api/admin/accounts/:orgId/sync - Sync organization data from WorkOS and Stripe
  apiRouter.post(
    "/accounts/:orgId/sync",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();
        const syncResults: {
          success: boolean;
          workos?: { success: boolean; email?: string; error?: string };
          stripe?: {
            success: boolean;
            subscription?: {
              status: string;
              amount: number | null;
              interval: string | null;
              current_period_end: number | null;
              canceled_at: number | null;
            };
            error?: string;
          };
          updated?: boolean;
        } = { success: false };

        const orgResult = await pool.query(
          "SELECT workos_organization_id, stripe_customer_id FROM organizations WHERE workos_organization_id = $1",
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];

        // Sync from WorkOS
        if (workos) {
          try {
            const memberships =
              await workos.userManagement.listOrganizationMemberships({
                organizationId: orgId,
              });

            if (memberships.data && memberships.data.length > 0) {
              const sortedMembers = [...memberships.data].sort((a, b) => {
                const roleOrder = { owner: 0, admin: 1, member: 2 };
                const aRole = (a.role?.slug || "member") as keyof typeof roleOrder;
                const bRole = (b.role?.slug || "member") as keyof typeof roleOrder;
                return (roleOrder[aRole] ?? 2) - (roleOrder[bRole] ?? 2);
              });

              const primaryMember = sortedMembers[0];
              try {
                const user = await workos.userManagement.getUser(
                  primaryMember.userId
                );
                syncResults.workos = {
                  success: true,
                  email: user.email,
                };
              } catch (userError) {
                logger.warn(
                  { err: userError, userId: primaryMember.userId },
                  "Failed to fetch user details during sync"
                );
                syncResults.workos = {
                  success: true,
                  error: "Could not fetch user email",
                };
              }
            } else {
              syncResults.workos = {
                success: true,
                error: "No members found in organization",
              };
            }
          } catch (error) {
            syncResults.workos = {
              success: false,
              error: "Failed to sync from WorkOS",
            };
          }
        } else {
          syncResults.workos = {
            success: false,
            error: "WorkOS not initialized",
          };
        }

        // Sync from Stripe
        if (org.stripe_customer_id) {
          if (stripe) {
            try {
              const customer = await stripe.customers.retrieve(
                org.stripe_customer_id,
                {
                  expand: ["subscriptions"],
                }
              );

              if (customer.deleted) {
                syncResults.stripe = {
                  success: true,
                  error: "Customer has been deleted",
                };
              } else {
                const subscriptions = (customer as Stripe.Customer).subscriptions;

                if (subscriptions && subscriptions.data.length > 0) {
                  const subscription = subscriptions.data[0];
                  const priceData = subscription.items.data[0]?.price;

                  await pool.query(
                    `UPDATE organizations
                     SET subscription_status = $1,
                         subscription_amount = $2,
                         subscription_interval = $3,
                         subscription_currency = $4,
                         subscription_current_period_end = $5,
                         subscription_canceled_at = $6,
                         updated_at = NOW()
                     WHERE workos_organization_id = $7`,
                    [
                      subscription.status,
                      priceData?.unit_amount || null,
                      priceData?.recurring?.interval || null,
                      priceData?.currency || "usd",
                      subscription.current_period_end
                        ? new Date(subscription.current_period_end * 1000)
                        : null,
                      subscription.canceled_at
                        ? new Date(subscription.canceled_at * 1000)
                        : null,
                      orgId,
                    ]
                  );

                  syncResults.stripe = {
                    success: true,
                    subscription: {
                      status: subscription.status,
                      amount: priceData?.unit_amount ?? null,
                      interval: priceData?.recurring?.interval ?? null,
                      current_period_end: subscription.current_period_end ?? null,
                      canceled_at: subscription.canceled_at ?? null,
                    },
                  };
                  syncResults.updated = true;
                } else {
                  // No subscription - check for paid membership invoices (manual invoice flow)
                  const invoices = await stripe.invoices.list({
                    customer: org.stripe_customer_id,
                    status: 'paid',
                    limit: 10,
                  });

                  const membershipInvoice = invoices.data.find(inv => {
                    const lineItem = inv.lines?.data?.[0] as any;
                    const lookupKey = lineItem?.price?.lookup_key || '';
                    const productMetadata = lineItem?.price?.product?.metadata || {};
                    return (
                      lookupKey.startsWith('aao_membership_') ||
                      lookupKey.startsWith('aao_invoice_') ||
                      productMetadata.category === 'membership'
                    );
                  });

                  if (membershipInvoice && membershipInvoice.amount_paid > 0) {
                    const periodEnd = membershipInvoice.period_end
                      ? new Date(membershipInvoice.period_end * 1000)
                      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

                    await pool.query(
                      `UPDATE organizations
                       SET subscription_status = 'active',
                           subscription_amount = $1,
                           subscription_currency = $2,
                           subscription_current_period_end = $3,
                           updated_at = NOW()
                       WHERE workos_organization_id = $4`,
                      [
                        membershipInvoice.amount_paid,
                        membershipInvoice.currency || 'usd',
                        periodEnd,
                        orgId,
                      ]
                    );

                    syncResults.stripe = {
                      success: true,
                      subscription: {
                        status: 'active',
                        amount: membershipInvoice.amount_paid,
                        interval: 'year',
                        current_period_end: Math.floor(periodEnd.getTime() / 1000),
                        canceled_at: null,
                      },
                    };
                    syncResults.updated = true;

                    logger.info({
                      orgId,
                      invoiceId: membershipInvoice.id,
                      amount: membershipInvoice.amount_paid,
                      periodEnd: periodEnd.toISOString(),
                    }, 'Synced membership status from paid invoice (no subscription)');
                  } else {
                    syncResults.stripe = {
                      success: true,
                      error: "No active subscription or paid membership invoice found",
                    };
                  }
                }
              }
            } catch (error) {
              syncResults.stripe = {
                success: false,
                error: "Failed to sync from Stripe",
              };
            }
          } else {
            syncResults.stripe = {
              success: false,
              error: "Stripe not initialized",
            };
          }
        } else {
          syncResults.stripe = {
            success: false,
            error: "No Stripe customer ID",
          };
        }

        syncResults.success =
          (syncResults.workos?.success || false) &&
          (syncResults.stripe?.success || false);

        res.json(syncResults);
      } catch (error) {
        logger.error({ err: error, orgId }, "Error syncing organization data");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to sync organization data",
        });
      }
    }
  );

  // GET /api/admin/accounts/:orgId/payments - Get payment history for organization
  apiRouter.get(
    "/accounts/:orgId/payments",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();

        const result = await pool.query(
          `SELECT
            revenue_type as event_type,
            amount_paid as amount_cents,
            currency,
            paid_at as event_timestamp,
            stripe_invoice_id,
            product_name
           FROM revenue_events
           WHERE workos_organization_id = $1
           ORDER BY paid_at DESC`,
          [orgId]
        );

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error, orgId }, "Error fetching payment history");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch payment history",
        });
      }
    }
  );

  // DELETE /api/admin/accounts/:orgId - Delete a workspace
  // Blocked if the org has any payment history or an active subscription.
  apiRouter.delete(
    "/accounts/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;
      const { confirmation } = req.body;

      try {
        const pool = getPool();

        const orgResult = await pool.query(
          "SELECT workos_organization_id, name, stripe_customer_id FROM organizations WHERE workos_organization_id = $1",
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({
            error: "Organization not found",
            message: "The specified organization does not exist",
          });
        }

        const org = orgResult.rows[0];

        const revenueResult = await pool.query(
          "SELECT COUNT(*) as count FROM revenue_events WHERE workos_organization_id = $1",
          [orgId]
        );

        const hasPayments = parseInt(revenueResult.rows[0].count) > 0;

        if (hasPayments) {
          return res.status(400).json({
            error: "Cannot delete paid workspace",
            message:
              "This workspace has payment history and cannot be deleted. Contact support if you need to remove this workspace.",
            has_payments: true,
          });
        }

        const orgDb = new OrganizationDatabase();
        const subscriptionInfo = await orgDb.getSubscriptionInfo(orgId);
        if (
          subscriptionInfo &&
          (subscriptionInfo.status === "active" ||
            subscriptionInfo.status === "past_due")
        ) {
          return res.status(400).json({
            error: "Cannot delete workspace with active subscription",
            message:
              "This workspace has an active subscription. Please cancel the subscription first before deleting the workspace.",
            has_active_subscription: true,
            subscription_status: subscriptionInfo.status,
          });
        }

        if (!confirmation || confirmation !== org.name) {
          return res.status(400).json({
            error: "Confirmation required",
            message: `To delete this workspace, please provide the exact name "${org.name}" in the confirmation field.`,
            requires_confirmation: true,
            organization_name: org.name,
          });
        }

        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: req.user!.id,
          action: "organization_deleted",
          resource_type: "organization",
          resource_id: orgId,
          details: {
            name: org.name,
            deleted_by: "admin",
            admin_email: req.user!.email,
          },
        });

        if (workos) {
          try {
            await workos.organizations.deleteOrganization(orgId);
            logger.info(
              { orgId, name: org.name, adminEmail: req.user!.email },
              "Deleted organization from WorkOS"
            );
          } catch (workosError) {
            logger.warn(
              { err: workosError, orgId },
              "Failed to delete organization from WorkOS - continuing with local deletion"
            );
          }
        }

        await pool.query(
          "DELETE FROM organizations WHERE workos_organization_id = $1",
          [orgId]
        );

        logger.info(
          { orgId, name: org.name, adminEmail: req.user!.email },
          "Admin deleted organization"
        );

        res.json({
          success: true,
          message: `Workspace "${org.name}" has been deleted`,
          deleted_org_id: orgId,
        });
      } catch (error) {
        logger.error({ err: error, orgId }, "Error deleting organization");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to delete organization",
        });
      }
    }
  );

  // POST /api/admin/accounts/:orgId/reset-subscription-state
  // Atomically clears all subscription-related fields to NULL.
  // Use when Stripe state is gone but the DB row is stale (e.g., post-audit cleanup,
  // unlinked customer with orphaned stripe_subscription_id blocking a unique constraint).
  apiRouter.post(
    "/accounts/:orgId/reset-subscription-state",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;
      const { confirmation, reason } = req.body;

      try {
        const pool = getPool();

        const orgResult = await pool.query(
          `SELECT workos_organization_id, name, stripe_customer_id,
                  subscription_status, stripe_subscription_id,
                  subscription_amount, subscription_currency, subscription_interval,
                  subscription_current_period_end, subscription_canceled_at,
                  subscription_product_id, subscription_product_name,
                  subscription_price_id, subscription_price_lookup_key,
                  membership_tier, subscription_metadata
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({
            error: "Organization not found",
            message: "The specified organization does not exist",
          });
        }

        const org = orgResult.rows[0];

        if (!reason || reason.trim().length < 10) {
          return res.status(400).json({
            error: "Reason required",
            message:
              "A reason of at least 10 characters is required for the audit record.",
          });
        }

        if (!confirmation || confirmation !== org.name) {
          return res.status(400).json({
            error: "Confirmation required",
            message: `To reset subscription state, provide the exact organization name "${org.name}" in the confirmation field.`,
            requires_confirmation: true,
            organization_name: org.name,
          });
        }

        // Refuse if the org has live Stripe subscriptions — caller should /sync or cancel first.
        if (org.stripe_customer_id && stripe) {
          const customer = await stripe.customers.retrieve(
            org.stripe_customer_id,
            { expand: ["subscriptions"] }
          );

          if (!customer.deleted) {
            const liveStatuses = ["active", "trialing", "past_due", "incomplete"];
            const liveSubs =
              (customer as Stripe.Customer).subscriptions?.data.filter(
                (sub: any) => liveStatuses.includes(sub.status)
              ) ?? [];

            if (liveSubs.length > 0) {
              return res.status(400).json({
                error: "Live subscriptions exist",
                message: `Organization has ${liveSubs.length} live Stripe subscription(s). Run /sync or cancel the subscription before resetting.`,
                live_subscription_ids: liveSubs.map((s: any) => s.id),
              });
            }
          }
        }

        const beforeState = {
          subscription_status: org.subscription_status,
          stripe_subscription_id: org.stripe_subscription_id,
          subscription_amount: org.subscription_amount,
          subscription_currency: org.subscription_currency,
          subscription_interval: org.subscription_interval,
          subscription_current_period_end: org.subscription_current_period_end,
          subscription_canceled_at: org.subscription_canceled_at,
          subscription_product_id: org.subscription_product_id,
          subscription_product_name: org.subscription_product_name,
          subscription_price_id: org.subscription_price_id,
          subscription_price_lookup_key: org.subscription_price_lookup_key,
          membership_tier: org.membership_tier,
          subscription_metadata: org.subscription_metadata,
        };

        await pool.query(
          `UPDATE organizations
           SET subscription_status = NULL,
               stripe_subscription_id = NULL,
               subscription_amount = NULL,
               subscription_currency = NULL,
               subscription_interval = NULL,
               subscription_current_period_end = NULL,
               subscription_canceled_at = NULL,
               subscription_product_id = NULL,
               subscription_product_name = NULL,
               subscription_price_id = NULL,
               subscription_price_lookup_key = NULL,
               membership_tier = NULL,
               subscription_metadata = NULL,
               updated_at = NOW()
           WHERE workos_organization_id = $1`,
          [orgId]
        );

        const orgDb = new OrganizationDatabase();
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: req.user!.id,
          action: "subscription_state_reset",
          resource_type: "organization",
          resource_id: orgId,
          details: {
            org_name: org.name,
            admin_email: req.user!.email,
            reason: reason.trim(),
            before_state: beforeState,
          },
        });

        logger.info(
          { orgId, orgName: org.name, adminEmail: req.user?.email },
          "Reset subscription state for organization"
        );

        res.json({
          success: true,
          message: `Subscription state reset for ${org.name}`,
          org_id: orgId,
          org_name: org.name,
          cleared_fields: Object.entries(beforeState)
            .filter(([, v]) => v !== null)
            .map(([k]) => k),
        });
      } catch (error) {
        logger.error({ err: error, orgId }, "Error resetting subscription state");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to reset subscription state",
        });
      }
    }
  );
}
