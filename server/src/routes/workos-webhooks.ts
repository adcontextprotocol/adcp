/**
 * WorkOS webhook routes
 *
 * Handles incoming webhooks from WorkOS for user, organization, and membership events.
 * Used to keep local tables in sync with WorkOS.
 *
 * Events handled:
 * - user.created, user.updated, user.deleted
 * - organization.created, organization.updated, organization.deleted
 * - organization_membership.created, organization_membership.updated, organization_membership.deleted
 * - organization_domain.created, organization_domain.updated, organization_domain.verified
 * - organization_domain.deleted, organization_domain.verification_failed
 *
 * Setup in WorkOS Dashboard:
 * 1. Go to Developers > Webhooks
 * 2. Add endpoint: https://your-domain/api/webhooks/workos
 * 3. Select events: user.*, organization.*, organization_membership.*, organization_domain.*
 * 4. Copy the signing secret to WORKOS_WEBHOOK_SECRET env var
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../logger.js';
import { getPool } from '../db/client.js';
import { workos } from '../auth/workos-client.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';
import { tryAutoLinkWebsiteUserToSlack } from '../slack/sync.js';
import { triageAndNotify } from '../services/prospect-triage.js';
import { researchDomain } from '../services/brand-enrichment.js';
import { resolvePreferredOrganization, backfillPrimaryOrganization } from '../db/users-db.js';
import { notifySystemError } from '../addie/error-notifier.js';
import {
  upsertOrganizationMembership,
  deleteOrganizationMembership,
  consumeInvitationSeatType,
  findSuccessorForPromotion,
  setMembershipRole,
} from '../db/membership-db.js';

const logger = createLogger('workos-webhooks');

const WORKOS_WEBHOOK_SECRET = process.env.WORKOS_WEBHOOK_SECRET;

interface OrganizationMembershipData {
  id: string;
  user_id: string;
  organization_id: string;
  status: 'active' | 'pending' | 'inactive';
  role?: { slug: string } | null;
  created_at: string;
  updated_at: string;
}

interface UserData {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
}

interface OrganizationDomainData {
  domain: string;
  state: 'verified' | 'pending';
}

/**
 * WorkOS organization_domain event data
 * This is the full domain object from organization_domain.* events
 */
interface OrganizationDomainEventData {
  id: string;
  domain: string;
  organization_id: string;
  state: 'verified' | 'pending' | 'failed';
}

interface OrganizationData {
  id: string;
  name: string;
  domains: OrganizationDomainData[];
  created_at: string;
  updated_at: string;
}

/**
 * Upsert organization membership to local database
 */
async function upsertMembership(
  membership: OrganizationMembershipData,
  user?: UserData
): Promise<void> {
  // If we don't have user data, fetch it from WorkOS
  let userData = user;
  if (!userData) {
    try {
      const workosUser = await workos.userManagement.getUser(membership.user_id);
      userData = {
        id: workosUser.id,
        email: workosUser.email,
        first_name: workosUser.firstName,
        last_name: workosUser.lastName,
        email_verified: workosUser.emailVerified,
        created_at: workosUser.createdAt,
        updated_at: workosUser.updatedAt,
      };
    } catch (error) {
      logger.error({ error, userId: membership.user_id }, 'Failed to fetch user from WorkOS');
      return;
    }
  }

  // Only sync active memberships
  if (membership.status !== 'active') {
    logger.debug({ membershipId: membership.id, status: membership.status }, 'Skipping non-active membership');
    return;
  }

  const role = membership.role?.slug || 'member';

  // Consume any pending seat_type assignment from the invitation
  const consumedSeatType = await consumeInvitationSeatType(membership.organization_id, userData.email);
  const hasExplicitSeatType = consumedSeatType !== null;
  const seatType = consumedSeatType || 'community_only';

  const { assigned_role } = await upsertOrganizationMembership({
    user_id: membership.user_id,
    organization_id: membership.organization_id,
    membership_id: membership.id,
    email: userData.email,
    first_name: userData.first_name,
    last_name: userData.last_name,
    role,
    seat_type: seatType,
    has_explicit_seat_type: hasExplicitSeatType,
  });

  // If the DB promoted this member to owner, sync the change to WorkOS
  if (assigned_role === 'owner' && role === 'member') {
    try {
      await workos.userManagement.updateOrganizationMembership(membership.id, {
        roleSlug: 'owner',
      });
      logger.info({
        membershipId: membership.id,
        userId: membership.user_id,
        orgId: membership.organization_id,
      }, 'Promoted member to owner — org had no admin');
    } catch (err) {
      // Roll back local promotion to stay in sync with WorkOS
      await setMembershipRole(membership.user_id, membership.organization_id, 'member')
        .catch((rollbackErr) => {
          logger.error({ err: rollbackErr, orgId: membership.organization_id },
            'Failed to roll back local owner promotion — local/WorkOS role divergence');
        });
      logger.warn({ err, orgId: membership.organization_id }, 'Failed to promote member to owner in WorkOS, rolled back local role');
    }
  }

  // Set primary_organization_id if not already set (prefer paying orgs)
  const preferredOrg = await resolvePreferredOrganization(membership.user_id);
  if (preferredOrg) {
    await backfillPrimaryOrganization(membership.user_id, preferredOrg);
  }
}

/**
 * Delete organization membership from local database
 */
async function deleteMembership(membership: OrganizationMembershipData): Promise<void> {
  const deletedRole = await deleteOrganizationMembership(membership.user_id, membership.organization_id);

  logger.info({
    membershipId: membership.id,
    userId: membership.user_id,
    orgId: membership.organization_id,
    role: deletedRole,
  }, 'Deleted organization membership');

  // If an admin/owner was removed, check if the org still has one.
  // Promote the longest-tenured remaining member to prevent ownerless orgs.
  if (deletedRole === 'admin' || deletedRole === 'owner') {
    try {
      const target = await findSuccessorForPromotion(membership.organization_id);
      if (!target) return;

      // Promote in WorkOS first, then mirror locally
      let promotedInWorkos = false;
      if (target.workos_membership_id) {
        await workos.userManagement.updateOrganizationMembership(
          target.workos_membership_id,
          { roleSlug: 'owner' }
        );
        promotedInWorkos = true;
      } else {
        // No cached membership ID — look it up from WorkOS
        const memberships = await workos.userManagement.listOrganizationMemberships({
          organizationId: membership.organization_id,
          userId: target.workos_user_id,
        });
        if (memberships.data.length > 0) {
          await workos.userManagement.updateOrganizationMembership(
            memberships.data[0].id,
            { roleSlug: 'owner' }
          );
          promotedInWorkos = true;
        } else {
          logger.warn({
            orgId: membership.organization_id,
            userId: target.workos_user_id,
          }, 'Successor has no WorkOS membership — cannot promote, org may be ownerless');
        }
      }
      if (promotedInWorkos) {
        await setMembershipRole(target.workos_user_id, membership.organization_id, 'owner');
        logger.info({
          orgId: membership.organization_id,
          promotedUserId: target.workos_user_id,
          previousOwnerId: membership.user_id,
        }, 'Promoted longest-tenured member to owner after admin/owner removal');
      }
    } catch (err) {
      logger.warn({ err, orgId: membership.organization_id }, 'Failed to promote successor after owner removal');
    }
  }
}

/**
 * Upsert user to local users table
 * Called on user.created and user.updated events
 */
async function upsertUser(user: UserData): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO users (
      workos_user_id,
      email,
      first_name,
      last_name,
      email_verified,
      workos_created_at,
      workos_updated_at,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (workos_user_id) DO UPDATE SET
      email = EXCLUDED.email,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      email_verified = EXCLUDED.email_verified,
      workos_updated_at = EXCLUDED.workos_updated_at,
      updated_at = NOW()`,
    [
      user.id,
      user.email,
      user.first_name,
      user.last_name,
      user.email_verified,
      user.created_at,
      user.updated_at,
    ]
  );

  logger.info({ userId: user.id, email: user.email }, 'Upserted user');
}

/**
 * Delete user from local users table
 * Called on user.deleted events
 */
async function deleteUser(userId: string): Promise<void> {
  const pool = getPool();

  await pool.query(
    `DELETE FROM users WHERE workos_user_id = $1`,
    [userId]
  );

  logger.info({ userId }, 'Deleted user');
}

/**
 * Update user details across all their memberships
 */
async function updateUserAcrossMemberships(user: UserData): Promise<void> {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE organization_memberships
     SET email = $1, first_name = $2, last_name = $3, synced_at = NOW(), updated_at = NOW()
     WHERE workos_user_id = $4`,
    [user.email, user.first_name, user.last_name, user.id]
  );

  logger.info({
    userId: user.id,
    updatedCount: result.rowCount,
  }, 'Updated user details across memberships');
}

/**
 * Delete all memberships for a user
 */
async function deleteUserMemberships(userId: string): Promise<void> {
  const pool = getPool();

  const result = await pool.query(
    `DELETE FROM organization_memberships WHERE workos_user_id = $1`,
    [userId]
  );

  logger.info({
    userId,
    deletedCount: result.rowCount,
  }, 'Deleted all memberships for user');
}

/**
 * Sync organization domains from WorkOS
 * This upserts domains and removes any that are no longer in WorkOS
 */
async function syncOrganizationDomains(org: OrganizationData): Promise<void> {
  const pool = getPool();

  // First check if the organization exists in our database
  const orgCheck = await pool.query(
    `SELECT workos_organization_id, is_personal FROM organizations WHERE workos_organization_id = $1`,
    [org.id]
  );

  if (orgCheck.rows.length === 0) {
    logger.debug({ orgId: org.id, orgName: org.name }, 'Organization not in our database, skipping domain sync');
    return;
  }

  if (orgCheck.rows[0].is_personal) {
    logger.debug({ orgId: org.id, orgName: org.name }, 'Personal organization, skipping domain sync');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current domains for this org
    const currentDomainsResult = await client.query(
      `SELECT domain FROM organization_domains WHERE workos_organization_id = $1`,
      [org.id]
    );
    const currentDomains = new Set(currentDomainsResult.rows.map(r => r.domain));

    // Upsert each domain from WorkOS
    const workOSDomains = new Set<string>();
    for (let i = 0; i < org.domains.length; i++) {
      const domainData = org.domains[i];
      workOSDomains.add(domainData.domain);

      await client.query(
        `INSERT INTO organization_domains (
          workos_organization_id, domain, is_primary, verified, source
        ) VALUES ($1, $2, $3, $4, 'workos')
        ON CONFLICT (domain) DO UPDATE SET
          workos_organization_id = EXCLUDED.workos_organization_id,
          verified = EXCLUDED.verified,
          source = 'workos',
          updated_at = NOW()`,
        [
          org.id,
          domainData.domain,
          i === 0, // First domain is primary
          domainData.state === 'verified',
        ]
      );
    }

    // Remove domains that are no longer in WorkOS (but only if they came from WorkOS)
    for (const currentDomain of currentDomains) {
      if (!workOSDomains.has(currentDomain)) {
        await client.query(
          `DELETE FROM organization_domains
           WHERE workos_organization_id = $1 AND domain = $2 AND source = 'workos'`,
          [org.id, currentDomain]
        );
        logger.info({ orgId: org.id, domain: currentDomain }, 'Removed domain no longer in WorkOS');
      }
    }

    // Update the email_domain column on organizations with the primary domain
    const primaryDomain = org.domains.length > 0 ? org.domains[0].domain : null;
    await client.query(
      `UPDATE organizations SET email_domain = $1, updated_at = NOW()
       WHERE workos_organization_id = $2`,
      [primaryDomain, org.id]
    );

    await client.query('COMMIT');

    logger.info({
      orgId: org.id,
      orgName: org.name,
      domainCount: org.domains.length,
      primaryDomain,
    }, 'Synced organization domains');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete all domains for an organization
 */
async function deleteOrganizationDomains(orgId: string): Promise<void> {
  const pool = getPool();

  const result = await pool.query(
    `DELETE FROM organization_domains WHERE workos_organization_id = $1`,
    [orgId]
  );

  logger.info({
    orgId,
    deletedCount: result.rowCount,
  }, 'Deleted all domains for organization');
}

/**
 * Upsert a single organization domain from organization_domain.* events
 * Uses transaction to prevent race conditions when setting primary domain
 */
async function upsertOrganizationDomain(domainData: OrganizationDomainEventData): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if org exists (with lock to prevent races)
    const orgCheck = await client.query(
      `SELECT workos_organization_id, is_personal FROM organizations
       WHERE workos_organization_id = $1 FOR UPDATE`,
      [domainData.organization_id]
    );

    if (orgCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      logger.debug(
        { orgId: domainData.organization_id, domain: domainData.domain },
        'Organization not in our database, skipping domain upsert'
      );
      return;
    }

    if (orgCheck.rows[0].is_personal) {
      await client.query('ROLLBACK');
      logger.debug(
        { orgId: domainData.organization_id, domain: domainData.domain },
        'Personal organization, skipping domain upsert'
      );
      return;
    }

    // Normalize domain to lowercase
    const normalizedDomain = domainData.domain.toLowerCase();

    await client.query(
      `INSERT INTO organization_domains (
        workos_organization_id, domain, verified, source
      ) VALUES ($1, $2, $3, 'workos')
      ON CONFLICT (domain) DO UPDATE SET
        workos_organization_id = EXCLUDED.workos_organization_id,
        verified = EXCLUDED.verified,
        source = 'workos',
        updated_at = NOW()`,
      [
        domainData.organization_id,
        normalizedDomain,
        domainData.state === 'verified',
      ]
    );

    // If this is verified and there's no primary domain yet, make it primary (atomic)
    if (domainData.state === 'verified') {
      const updated = await client.query(
        `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
         WHERE workos_organization_id = $1 AND domain = $2
         AND NOT EXISTS (
           SELECT 1 FROM organization_domains
           WHERE workos_organization_id = $1 AND is_primary = true AND domain != $2
         )
         RETURNING domain`,
        [domainData.organization_id, normalizedDomain]
      );

      // If we set this as primary, also update the email_domain column
      if (updated.rows.length > 0) {
        await client.query(
          `UPDATE organizations SET email_domain = $1, updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [normalizedDomain, domainData.organization_id]
        );
      }
    }

    await client.query('COMMIT');

    logger.info({
      orgId: domainData.organization_id,
      domain: normalizedDomain,
      verified: domainData.state === 'verified',
    }, 'Upserted organization domain');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete a single organization domain
 * Uses transaction to prevent race conditions when selecting new primary
 */
async function deleteSingleOrganizationDomain(domainData: OrganizationDomainEventData): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Normalize domain to lowercase
    const normalizedDomain = domainData.domain.toLowerCase();

    const result = await client.query(
      `DELETE FROM organization_domains
       WHERE workos_organization_id = $1 AND domain = $2 AND source = 'workos'
       RETURNING is_primary`,
      [domainData.organization_id, normalizedDomain]
    );

    if (result.rowCount && result.rowCount > 0) {
      const wasPrimary = result.rows[0]?.is_primary;

      // If we deleted the primary domain, pick a new one
      let newPrimary: string | null = null;
      if (wasPrimary) {
        const remaining = await client.query(
          `SELECT domain FROM organization_domains
           WHERE workos_organization_id = $1 AND verified = true
           ORDER BY created_at ASC
           LIMIT 1`,
          [domainData.organization_id]
        );

        newPrimary = remaining.rows.length > 0 ? remaining.rows[0].domain : null;

        if (newPrimary) {
          await client.query(
            `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
             WHERE workos_organization_id = $1 AND domain = $2`,
            [domainData.organization_id, newPrimary]
          );
        }

        await client.query(
          `UPDATE organizations SET email_domain = $1, updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [newPrimary, domainData.organization_id]
        );
      }

      await client.query('COMMIT');

      logger.info({
        orgId: domainData.organization_id,
        domain: normalizedDomain,
        wasPrimary,
        newPrimary,
      }, 'Deleted organization domain');
    } else {
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Create WorkOS webhooks router
 */
export function createWorkOSWebhooksRouter(): Router {
  const router = Router();

  router.post(
    '/workos',
    // Parse JSON body manually since the global JSON parser is skipped for this route
    (req: Request, res: Response, next) => {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { rawBody += chunk; });
      req.on('end', () => {
        try {
          req.body = JSON.parse(rawBody);
          next();
        } catch {
          logger.warn({ rawBodyLength: rawBody.length }, 'Invalid JSON in WorkOS webhook request');
          res.status(400).json({ error: 'Invalid JSON' });
        }
      });
    },
    async (req: Request, res: Response) => {
      const startTime = Date.now();

      try {
        const rawSigHeader = req.headers['workos-signature'];
        const sigHeader = Array.isArray(rawSigHeader) ? rawSigHeader[0] : rawSigHeader;

        logger.info({
          event: req.body?.event,
          hasSigHeader: !!sigHeader,
        }, 'Received WorkOS webhook');

        if (!WORKOS_WEBHOOK_SECRET) {
          logger.error('WORKOS_WEBHOOK_SECRET not configured — rejecting webhook');
          notifySystemError({ source: 'workos-webhook', errorMessage: 'WORKOS_WEBHOOK_SECRET not configured — all webhooks rejected' });
          return res.status(401).json({ error: 'Webhook verification unavailable' });
        }

        if (!sigHeader) {
          logger.warn('Missing WorkOS-Signature header');
          return res.status(401).json({ error: 'Missing signature' });
        }

        try {
          await workos.webhooks.constructEvent({
            payload: req.body,
            sigHeader,
            secret: WORKOS_WEBHOOK_SECRET,
          });
        } catch (err) {
          logger.warn({ err }, 'WorkOS webhook signature verification failed');
          notifySystemError({ source: 'workos-webhook-sig', errorMessage: `Signature verification failed for ${req.body?.event || 'unknown'} — check WORKOS_WEBHOOK_SECRET` });
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const event = req.body as { id: string; event: string; data: Record<string, unknown>; created_at: string };

        switch (event.event) {
          case 'organization_membership.created': {
            const membership = event.data as unknown as OrganizationMembershipData;
            await upsertMembership(membership);
            // Try to auto-link to Slack account by email (in case user.created didn't catch it)
            if (membership.status === 'active') {
              let workosUser: any;
              try {
                workosUser = await workos.userManagement.getUser(membership.user_id);
              } catch (error) {
                logger.debug({ error, userId: membership.user_id }, 'Could not fetch user for auto-link on membership');
              }

              if (workosUser) {
                // Slack auto-link
                try {
                  const linkResult = await tryAutoLinkWebsiteUserToSlack(membership.user_id, workosUser.email);
                  if (linkResult.linked) {
                    logger.info(
                      { userId: membership.user_id, email: workosUser.email, slackUserId: linkResult.slack_user_id },
                      'Auto-linked website user to Slack account on membership creation'
                    );
                  }
                } catch (slackErr) {
                  logger.debug({ error: slackErr, userId: membership.user_id }, 'Could not auto-link Slack on membership');
                }

                // Match pending certification expectations by email
                try {
                  const { matchExpectationToUser } = await import('../db/certification-db.js');
                  const matched = await matchExpectationToUser(
                    membership.organization_id,
                    workosUser.email,
                    membership.user_id
                  );
                  if (matched) {
                    logger.info(
                      { userId: membership.user_id, email: workosUser.email, orgId: membership.organization_id },
                      'Matched certification expectation to new org member'
                    );
                  }
                } catch (certErr) {
                  logger.warn({ error: certErr, userId: membership.user_id }, 'Could not match cert expectation on membership');
                }
              }
            }
            invalidateUnifiedUsersCache();
            break;
          }

          case 'organization_membership.updated': {
            const membership = event.data as unknown as OrganizationMembershipData;
            await upsertMembership(membership);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'organization_membership.deleted': {
            const membership = event.data as unknown as OrganizationMembershipData;
            await deleteMembership(membership);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'user.created': {
            const user = event.data as unknown as UserData;
            await upsertUser(user);
            // Try to auto-link to Slack account by email
            const linkResult = await tryAutoLinkWebsiteUserToSlack(user.id, user.email);
            if (linkResult.linked) {
              logger.info(
                { userId: user.id, email: user.email, slackUserId: linkResult.slack_user_id },
                'Auto-linked new website user to Slack account'
              );
            }
            // Fire-and-forget prospect triage for business emails.
            // Assess + notify only — don't create an org. The user creates their
            // own org during onboarding; enrichment runs on organization.created.
            if (user.email && process.env.ANTHROPIC_API_KEY) {
              const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
              const domain = user.email.split('@')[1];
              triageAndNotify(domain, { name, email: user.email, source: 'inbound' }).catch(err => {
                logger.error({ err, domain }, 'Prospect triage failed for new website user');
              });
            }
            invalidateUnifiedUsersCache();
            break;
          }

          case 'user.updated': {
            const user = event.data as unknown as UserData;
            await upsertUser(user);
            await updateUserAcrossMemberships(user);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'user.deleted': {
            const user = event.data as unknown as UserData;
            await deleteUser(user.id);
            await deleteUserMemberships(user.id);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'organization.created': {
            const newOrg = event.data as unknown as OrganizationData;
            await syncOrganizationDomains(newOrg);
            // Auto-research the primary domain for brand registry coverage
            const primaryDomain = newOrg.domains.length > 0 ? newOrg.domains[0].domain : null;
            if (primaryDomain) {
              researchDomain(primaryDomain, { org_id: newOrg.id }).catch(err => {
                logger.warn({ err, orgId: newOrg.id, domain: primaryDomain }, 'Background research failed for new org');
              });
            }
            break;
          }
          case 'organization.updated': {
            const org = event.data as unknown as OrganizationData;
            await syncOrganizationDomains(org);
            break;
          }

          case 'organization.deleted': {
            const org = event.data as unknown as OrganizationData;
            await deleteOrganizationDomains(org.id);
            break;
          }

          // organization_domain.* events for granular domain management
          case 'organization_domain.created':
          case 'organization_domain.updated':
          case 'organization_domain.verified': {
            const domainData = event.data as unknown as OrganizationDomainEventData;
            await upsertOrganizationDomain(domainData);
            break;
          }

          case 'organization_domain.deleted':
          case 'organization_domain.verification_failed': {
            const domainData = event.data as unknown as OrganizationDomainEventData;
            await deleteSingleOrganizationDomain(domainData);
            break;
          }

          default:
            logger.debug({ event: event.event }, 'Ignoring unhandled WorkOS event');
        }

        const durationMs = Date.now() - startTime;
        logger.info({ event: event.event, durationMs }, 'Processed WorkOS webhook');

        return res.status(200).json({ ok: true });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const eventType = req.body?.event || 'unknown';
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error({ error, durationMs, event: eventType }, 'Error processing WorkOS webhook');
        notifySystemError({ source: 'workos-webhook', errorMessage: `Failed to process ${eventType}: ${errMsg}` });
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return router;
}

/**
 * Backfill organization memberships from WorkOS
 * Call this to populate the table initially or to resync.
 *
 * Upserts every active membership from WorkOS and removes local rows
 * whose memberships no longer exist (deleted during a webhook outage).
 */
export async function backfillOrganizationMemberships(): Promise<{
  orgsProcessed: number;
  membershipsCreated: number;
  membershipsRemoved: number;
  errors: string[];
}> {
  const pool = getPool();
  const result = {
    orgsProcessed: 0,
    membershipsCreated: 0,
    membershipsRemoved: 0,
    errors: [] as string[],
  };

  logger.info('Starting organization memberships backfill');

  try {
    // Get all organizations from our database
    const orgsResult = await pool.query(
      `SELECT workos_organization_id FROM organizations`
    );

    const BATCH_SIZE = 10;
    const orgs = orgsResult.rows;

    // Track every active (user, org) pair seen in WorkOS
    const seenMemberships = new Set<string>();
    // Track orgs that were fully fetched without errors
    const successfulOrgIds = new Set<string>();

    for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
      const batch = orgs.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (org) => {
        try {
          // Fetch users for this org from WorkOS
          let after: string | undefined;
          do {
            const usersResponse = await workos.userManagement.listUsers({
              organizationId: org.workos_organization_id,
              limit: 100,
              after,
            });

            for (const user of usersResponse.data) {
              try {
                // Get the membership ID for this user in this org
                const membershipsResponse = await workos.userManagement.listOrganizationMemberships({
                  userId: user.id,
                });

                const membership = membershipsResponse.data.find(
                  (m) => m.organizationId === org.workos_organization_id,
                );
                if (membership && membership.status === 'active') {
                  seenMemberships.add(`${user.id}:${org.workos_organization_id}`);
                  const role = membership.role?.slug || 'member';
                  await upsertOrganizationMembership({
                    user_id: user.id,
                    organization_id: org.workos_organization_id,
                    membership_id: membership.id,
                    email: user.email,
                    first_name: user.firstName,
                    last_name: user.lastName,
                    role,
                    seat_type: 'community_only',
                    has_explicit_seat_type: false,
                  });
                  result.membershipsCreated++;
                }
              } catch (memberError) {
                const msg = `Failed to process membership for user ${user.id}: ${memberError}`;
                result.errors.push(msg);
                logger.warn({ error: memberError, userId: user.id }, 'Backfill: failed to process membership');
              }
            }

            after = usersResponse.data.length === 100
              ? usersResponse.data[usersResponse.data.length - 1].id
              : undefined;
          } while (after);

          successfulOrgIds.add(org.workos_organization_id);
          result.orgsProcessed++;
        } catch (orgError) {
          const msg = `Failed to process org ${org.workos_organization_id}: ${orgError}`;
          result.errors.push(msg);
          logger.warn({ error: orgError, orgId: org.workos_organization_id }, 'Backfill: failed to process org');
        }
      }));
    }

    // Remove local memberships that no longer exist in WorkOS.
    // Only delete for orgs we successfully processed (avoid deleting
    // rows when the WorkOS fetch failed for that org).
    const processedOrgIds = [...successfulOrgIds];

    if (processedOrgIds.length > 0) {
      const localMemberships = await pool.query<{
        workos_user_id: string;
        workos_organization_id: string;
      }>(
        `SELECT workos_user_id, workos_organization_id
         FROM organization_memberships
         WHERE workos_organization_id = ANY($1)`,
        [processedOrgIds],
      );

      for (const row of localMemberships.rows) {
        const key = `${row.workos_user_id}:${row.workos_organization_id}`;
        if (!seenMemberships.has(key)) {
          await deleteOrganizationMembership(row.workos_user_id, row.workos_organization_id);
          result.membershipsRemoved++;
          logger.info({
            userId: row.workos_user_id,
            orgId: row.workos_organization_id,
          }, 'Backfill: removed stale membership not found in WorkOS');
        }
      }
    }

    // Invalidate cache after backfill
    invalidateUnifiedUsersCache();

    logger.info(result, 'Completed organization memberships backfill');
    return result;
  } catch (error) {
    logger.error({ error }, 'Organization memberships backfill failed');
    result.errors.push(`Backfill failed: ${error}`);
    return result;
  }
}

/**
 * Backfill users table from WorkOS
 * Fetches all users from all organizations and upserts them into the users table.
 *
 * Also removes local user rows that no longer appear in any WorkOS org
 * (deleted during a webhook outage).
 */
export async function backfillUsers(): Promise<{
  usersProcessed: number;
  usersCreated: number;
  usersRemoved: number;
  usersSkipped: number;
  errors: string[];
}> {
  const pool = getPool();
  const result = {
    usersProcessed: 0,
    usersCreated: 0,
    usersRemoved: 0,
    usersSkipped: 0,
    errors: [] as string[],
  };

  logger.info('Starting users backfill from WorkOS');

  try {
    // Get all organizations from our database
    const orgsResult = await pool.query(
      `SELECT workos_organization_id FROM organizations`
    );

    const processedUserIds = new Set<string>();
    const BATCH_SIZE = 10;
    const orgs = orgsResult.rows;

    for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
      const batch = orgs.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (org) => {
        try {
          // Fetch users for this org from WorkOS
          let after: string | undefined;
          do {
            const usersResponse = await workos.userManagement.listUsers({
              organizationId: org.workos_organization_id,
              limit: 100,
              after,
            });

            for (const user of usersResponse.data) {
              // Skip if we've already processed this user (they may be in multiple orgs)
              if (processedUserIds.has(user.id)) {
                continue;
              }
              processedUserIds.add(user.id);

              try {
                await pool.query(
                  `INSERT INTO users (
                    workos_user_id,
                    email,
                    first_name,
                    last_name,
                    email_verified,
                    workos_created_at,
                    workos_updated_at,
                    created_at,
                    updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                  ON CONFLICT (workos_user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    first_name = EXCLUDED.first_name,
                    last_name = EXCLUDED.last_name,
                    email_verified = EXCLUDED.email_verified,
                    workos_updated_at = EXCLUDED.workos_updated_at,
                    updated_at = NOW()`,
                  [
                    user.id,
                    user.email,
                    user.firstName,
                    user.lastName,
                    user.emailVerified,
                    user.createdAt,
                    user.updatedAt,
                  ]
                );
                result.usersCreated++;
              } catch (userError) {
                const msg = `Failed to upsert user ${user.id}: ${userError}`;
                result.errors.push(msg);
                logger.warn({ error: userError, userId: user.id }, 'Backfill: failed to upsert user');
              }

              result.usersProcessed++;
            }

            after = usersResponse.data.length === 100
              ? usersResponse.data[usersResponse.data.length - 1].id
              : undefined;
          } while (after);
        } catch (orgError) {
          const msg = `Failed to fetch users for org ${org.workos_organization_id}: ${orgError}`;
          result.errors.push(msg);
          logger.warn({ error: orgError, orgId: org.workos_organization_id }, 'Backfill: failed to fetch org users');
        }
      }));
    }

    // Remove local users that no longer exist in WorkOS.
    // Verify each candidate against WorkOS directly — a user may exist
    // in WorkOS without being in any org (e.g. individual members).
    if (processedUserIds.size > 0) {
      const localUsers = await pool.query<{ workos_user_id: string }>(
        `SELECT workos_user_id FROM users`,
      );

      const candidates = localUsers.rows.filter(
        row => !processedUserIds.has(row.workos_user_id)
      );

      logger.info({ count: candidates.length }, 'Backfill: verifying deletion candidates against WorkOS');

      const VERIFY_BATCH_SIZE = 10;
      for (let i = 0; i < candidates.length; i += VERIFY_BATCH_SIZE) {
        const batch = candidates.slice(i, i + VERIFY_BATCH_SIZE);

        await Promise.all(batch.map(async (row) => {
          try {
            // Confirm the user is actually gone from WorkOS before deleting
            await workos.userManagement.getUser(row.workos_user_id);
            // User still exists in WorkOS — skip deletion
            result.usersSkipped++;
          } catch (getErr: any) {
            if (getErr?.status === 404 || getErr?.code === 'entity_not_found') {
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(`DELETE FROM organization_memberships WHERE workos_user_id = $1`, [row.workos_user_id]);
                await client.query(`DELETE FROM users WHERE workos_user_id = $1`, [row.workos_user_id]);
                await client.query('COMMIT');
                result.usersRemoved++;
                logger.info({ userId: row.workos_user_id }, 'Backfill: removed user confirmed deleted from WorkOS');
              } catch (err) {
                await client.query('ROLLBACK');
                // FK constraints prevent deletion of users with platform activity
                // (community_points, certifications, etc.) — this is expected
                result.usersSkipped++;
                logger.info({ error: err, userId: row.workos_user_id }, 'Backfill: user deleted from WorkOS but retained locally due to platform activity');
              } finally {
                client.release();
              }
            } else {
              // WorkOS API error — don't delete, log the error
              result.errors.push(`Could not verify user ${row.workos_user_id}: ${getErr}`);
              result.usersSkipped++;
            }
          }
        }));
      }
    }

    // Invalidate cache after backfill
    invalidateUnifiedUsersCache();

    logger.info(result, 'Completed users backfill');
    return result;
  } catch (error) {
    logger.error({ error }, 'Users backfill failed');
    result.errors.push(`Backfill failed: ${error}`);
    return result;
  }
}

/**
 * Backfill organization domains from WorkOS
 * Fetches each org from WorkOS and syncs its domain list using the same
 * logic as the organization.created/updated webhook handlers.
 */
export async function backfillOrganizationDomains(): Promise<{
  orgsProcessed: number;
  domainsSynced: number;
  errors: string[];
}> {
  const pool = getPool();
  const result = {
    orgsProcessed: 0,
    domainsSynced: 0,
    errors: [] as string[],
  };

  logger.info('Starting organization domains backfill from WorkOS');

  try {
    const orgsResult = await pool.query<{
      workos_organization_id: string;
      is_personal: boolean;
    }>(
      `SELECT workos_organization_id, COALESCE(is_personal, false) AS is_personal
       FROM organizations`,
    );

    const BATCH_SIZE = 10;
    const orgs = orgsResult.rows.filter(o => !o.is_personal);

    for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
      const batch = orgs.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (org) => {
        try {
          const workosOrg = await workos.organizations.getOrganization(org.workos_organization_id);

          // Map WorkOS SDK response to the shape syncOrganizationDomains expects
          const orgData: OrganizationData = {
            id: workosOrg.id,
            name: workosOrg.name,
            domains: (workosOrg.domains || []).map((d: { domain: string; state: string }) => ({
              domain: d.domain,
              state: d.state as 'verified' | 'pending',
            })),
            created_at: workosOrg.createdAt,
            updated_at: workosOrg.updatedAt,
          };

          await syncOrganizationDomains(orgData);
          result.domainsSynced += orgData.domains.length;
          result.orgsProcessed++;
        } catch (orgError) {
          const msg = `Failed to sync domains for org ${org.workos_organization_id}: ${orgError}`;
          result.errors.push(msg);
          logger.warn({ error: orgError, orgId: org.workos_organization_id }, 'Backfill: failed to sync org domains');
        }
      }));
    }

    logger.info(result, 'Completed organization domains backfill');
    return result;
  } catch (error) {
    logger.error({ error }, 'Organization domains backfill failed');
    result.errors.push(`Backfill failed: ${error}`);
    return result;
  }
}
