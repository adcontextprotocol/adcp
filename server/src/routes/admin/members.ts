/**
 * Admin members routes
 *
 * Handles member listing, syncing, and workspace management including:
 * - List all members with subscription info
 * - Sync organization data from WorkOS and Stripe
 * - Update membership roles
 * - Get payment history
 * - Delete workspaces
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import Stripe from "stripe";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { stripe } from "../../billing/stripe-client.js";

const logger = createLogger("admin-members");

interface MembersRoutesConfig {
  workos: WorkOS | null;
}

/**
 * Setup admin members routes
 */
export function setupMembersRoutes(
  apiRouter: Router,
  config: MembersRoutesConfig
): void {
  const { workos } = config;

  // GET /api/admin/members - List all members with subscription info
  apiRouter.get("/members", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Get all organizations with primary contact email using a single query
      // Uses LEFT JOIN LATERAL to get first member per org (by created_at)
      // Note: This returns the first member by signup date, not necessarily the "owner" role
      const result = await pool.query(`
        SELECT
          o.workos_organization_id,
          o.name,
          o.company_type,
          o.revenue_tier,
          o.is_personal,
          o.stripe_customer_id,
          o.created_at,
          o.subscription_status,
          o.subscription_amount,
          o.subscription_interval,
          o.subscription_currency,
          o.subscription_canceled_at,
          o.subscription_current_period_end,
          o.agreement_signed_at,
          o.agreement_version,
          COALESCE(first_member.email, 'No contact') as primary_email
        FROM organizations o
        LEFT JOIN LATERAL (
          SELECT email
          FROM organization_memberships om
          WHERE om.workos_organization_id = o.workos_organization_id
          ORDER BY om.created_at ASC
          LIMIT 1
        ) first_member ON true
        ORDER BY o.created_at DESC
      `);

      // Map results to response format
      const members = result.rows.map((row) => {
        // Convert timestamp to Unix timestamp (seconds) for JavaScript Date compatibility
        const periodEndTimestamp = row.subscription_current_period_end
          ? Math.floor(
              new Date(row.subscription_current_period_end).getTime() / 1000
            )
          : null;

        // Use subscription_status from database (populated by Stripe webhooks)
        const subscriptionStatus = row.subscription_status || "none";

        return {
          company_id: row.workos_organization_id, // Keep company_id name for backwards compatibility
          company_name: row.name, // Keep company_name for backwards compatibility
          company_type: row.company_type,
          revenue_tier: row.revenue_tier,
          is_personal: row.is_personal,
          stripe_customer_id: row.stripe_customer_id,
          created_at: row.created_at,
          subscription_status: subscriptionStatus,
          subscription_amount: row.subscription_amount,
          subscription_interval: row.subscription_interval,
          subscription_currency: row.subscription_currency || "usd",
          subscription_current_period_end: periodEndTimestamp,
          subscription_canceled_at: row.subscription_canceled_at,
          agreement_signed_at: row.agreement_signed_at,
          agreement_version: row.agreement_version,
          owner_email: row.primary_email, // Backwards compatible field name
        };
      });

      res.json(members);
    } catch (error) {
      logger.error({ err: error }, "Error fetching admin members");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch members list",
      });
    }
  });

  // POST /api/admin/members/:orgId/sync - Sync organization data from WorkOS and Stripe
  apiRouter.post(
    "/members/:orgId/sync",
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

        // Get the organization from database
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
              // Sort by role preference: owner > admin > member
              const sortedMembers = [...memberships.data].sort((a, b) => {
                const roleOrder = { owner: 0, admin: 1, member: 2 };
                const aRole = (a.role?.slug || "member") as keyof typeof roleOrder;
                const bRole = (b.role?.slug || "member") as keyof typeof roleOrder;
                return (roleOrder[aRole] ?? 2) - (roleOrder[bRole] ?? 2);
              });

              const primaryMember = sortedMembers[0];
              // Fetch user details since membership.user is not populated
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
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown error fetching from WorkOS",
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
              // Get customer with subscriptions
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

                  // Update organization with fresh subscription data
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
                  // No subscription - check for paid membership invoices
                  // This handles customers who paid via manual invoice
                  const invoices = await stripe.invoices.list({
                    customer: org.stripe_customer_id,
                    status: 'paid',
                    limit: 10,
                  });

                  // Find the most recent paid membership invoice
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
                    // Calculate period end (use invoice period_end or default to 1 year from payment)
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
                        interval: 'year', // Manual invoices are typically annual
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
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown error fetching from Stripe",
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

  // PATCH /api/admin/members/:orgId/memberships/:membershipId - Update membership role (admin bootstrap)
  // Used to fix organizations that have no owner
  apiRouter.patch(
    "/members/:orgId/memberships/:membershipId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId, membershipId } = req.params;
      const { role } = req.body;

      if (!role || !["owner", "admin", "member"].includes(role)) {
        return res.status(400).json({
          error: "Invalid role",
          message: "Role must be owner, admin, or member",
        });
      }

      if (!workos) {
        return res.status(500).json({
          error: "WorkOS not configured",
          message: "Cannot update membership without WorkOS",
        });
      }

      // Validate membership ID format (WorkOS membership IDs are 'om_' followed by alphanumeric chars)
      const WORKOS_ID_PATTERN = /^om_[A-Za-z0-9]{20,30}$/;
      if (!WORKOS_ID_PATTERN.test(membershipId)) {
        logger.error(
          { orgId, membershipId },
          "Invalid WorkOS membership ID format"
        );
        return res.status(400).json({
          error: "Invalid membership ID",
          message: "Unable to update role due to invalid membership data. Please contact support.",
        });
      }

      try {
        // Verify membership belongs to this org
        let membership;
        try {
          membership =
            await workos.userManagement.getOrganizationMembership(membershipId);
        } catch (getMembershipError) {
          logger.error(
            { err: getMembershipError, orgId, membershipId },
            "Failed to get membership from WorkOS"
          );
          return res.status(500).json({
            error: "Unable to verify membership",
            message: "Unable to update role. Please try again or contact support.",
          });
        }

        if (membership.organizationId !== orgId) {
          return res.status(400).json({
            error: "Invalid membership",
            message:
              "This membership does not belong to the specified organization",
          });
        }

        // Verify the target role exists in WorkOS for this organization
        try {
          const roles = await workos.organizations.listOrganizationRoles({
            organizationId: orgId,
          });
          const roleExists = roles.data.some((r) => r.slug === role);
          if (!roleExists) {
            logger.warn(
              {
                orgId,
                role,
                availableRoles: roles.data.map((r) => r.slug),
              },
              "Target role does not exist in WorkOS organization"
            );
            return res.status(400).json({
              error: "Role not available",
              message: `The '${role}' role is not configured for this organization. Please contact support to set up the role.`,
            });
          }
        } catch (rolesError) {
          // If we can't list roles, log warning but proceed - the update will fail if role doesn't exist
          logger.warn(
            { err: rolesError, orgId, role },
            "Could not verify role exists - proceeding with update attempt"
          );
        }

        // Update the membership role
        let updatedMembership;
        try {
          updatedMembership =
            await workos.userManagement.updateOrganizationMembership(
              membershipId,
              {
                roleSlug: role,
              }
            );
        } catch (updateError) {
          const updateErrorMessage =
            updateError instanceof Error ? updateError.message : "Unknown error";

          // Extract WorkOS-specific error details for logging
          const workosErrorDetails =
            updateError && typeof updateError === "object"
              ? {
                  code: (updateError as { code?: string }).code,
                  errors: (updateError as { errors?: unknown }).errors,
                  requestID: (updateError as { requestID?: string }).requestID,
                  rawData: (updateError as { rawData?: unknown }).rawData,
                }
              : undefined;

          logger.error(
            {
              err: updateError,
              errorMessage: updateErrorMessage,
              workosErrorDetails,
              orgId,
              membershipId,
              role,
            },
            "Failed to update membership role in WorkOS"
          );

          // Provide more specific error message based on error type
          let userMessage =
            "Unable to update role. Please try again or contact support.";
          if (
            updateErrorMessage.includes("pattern") ||
            updateErrorMessage.includes("validation")
          ) {
            userMessage =
              "Unable to update role due to a configuration issue. Please contact support.";
          }

          return res.status(500).json({
            error: "Unable to update role",
            message: userMessage,
          });
        }

        logger.info(
          { orgId, membershipId, role, adminEmail: req.user!.email },
          "Admin updated membership role"
        );

        res.json({
          success: true,
          membership: {
            id: updatedMembership.id,
            user_id: updatedMembership.userId,
            role: updatedMembership.role?.slug || "member",
          },
        });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(
          { err: error, errorMessage, orgId, membershipId },
          "Admin update membership role error"
        );
        return res.status(500).json({
          error: "Internal server error",
          message: "Unable to update membership role. Please try again or contact support.",
        });
      }
    }
  );

  // GET /api/admin/members/:orgId/payments - Get payment history for organization
  apiRouter.get(
    "/members/:orgId/payments",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();

        // Get payment history from revenue_events table
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

  // DELETE /api/admin/members/:orgId - Delete a workspace (organization)
  // Cannot delete if organization has any payment history (revenue events)
  apiRouter.delete(
    "/members/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;
      const { confirmation } = req.body;

      try {
        const pool = getPool();

        // Get the organization
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

        // Check if organization has any payment history
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

        // Check for active subscription (checks both Stripe and local DB)
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

        // Require confirmation by typing the organization name
        if (!confirmation || confirmation !== org.name) {
          return res.status(400).json({
            error: "Confirmation required",
            message: `To delete this workspace, please provide the exact name "${org.name}" in the confirmation field.`,
            requires_confirmation: true,
            organization_name: org.name,
          });
        }

        // Record audit log before deletion (while org still exists)
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

        // Delete from WorkOS if possible
        if (workos) {
          try {
            await workos.organizations.deleteOrganization(orgId);
            logger.info(
              { orgId, name: org.name, adminEmail: req.user!.email },
              "Deleted organization from WorkOS"
            );
          } catch (workosError) {
            // Log but don't fail - the org might not exist in WorkOS or could be a test org
            logger.warn(
              { err: workosError, orgId },
              "Failed to delete organization from WorkOS - continuing with local deletion"
            );
          }
        }

        // Delete from local database (cascades to related tables)
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
}
