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
import { BrandDatabase } from '../db/brand-db.js';
import { getWorkos } from '../auth/workos-client.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';
import { tryAutoLinkWebsiteUserToSlack } from '../slack/sync.js';
import { triageAndNotify } from '../services/prospect-triage.js';
import { researchDomain, trackBackground } from '../services/brand-enrichment.js';
import { isFreeEmailDomain } from '../utils/email-domain.js';
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
  domain?: string;
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
      const workosUser = await getWorkos().userManagement.getUser(membership.user_id);
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
      await getWorkos().userManagement.updateOrganizationMembership(membership.id, {
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
        await getWorkos().userManagement.updateOrganizationMembership(
          target.workos_membership_id,
          { roleSlug: 'owner' }
        );
        promotedInWorkos = true;
      } else {
        // No cached membership ID — look it up from WorkOS
        const memberships = await getWorkos().userManagement.listOrganizationMemberships({
          organizationId: membership.organization_id,
          userId: target.workos_user_id,
        });
        if (memberships.data.length > 0) {
          await getWorkos().userManagement.updateOrganizationMembership(
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

  // Resolve names: prefer WorkOS values, but when WorkOS sends empty names,
  // preserve existing DB values or backfill from Slack mapping
  let firstName = user.first_name;
  let lastName = user.last_name;

  if (!firstName?.trim() || !lastName?.trim()) {
    const existing = await pool.query<{
      first_name: string | null;
      last_name: string | null;
      slack_real_name: string | null;
      slack_display_name: string | null;
    }>(
      `SELECT u.first_name, u.last_name, sm.slack_real_name, sm.slack_display_name
       FROM users u
       LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = u.primary_slack_user_id
       WHERE u.workos_user_id = $1`,
      [user.id]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      // Keep existing DB names if WorkOS sends empty
      if (!firstName?.trim()) firstName = row.first_name;
      if (!lastName?.trim()) lastName = row.last_name;

      // Backfill from Slack if still empty
      if (!firstName?.trim() && !lastName?.trim()) {
        const slackName = row.slack_real_name || row.slack_display_name;
        if (slackName) {
          const parts = slackName.trim().split(/\s+/);
          firstName = parts[0];
          lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
        }
      }
    }
  }

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
      first_name = COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), users.first_name),
      last_name = COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), users.last_name),
      email_verified = EXCLUDED.email_verified,
      workos_updated_at = EXCLUDED.workos_updated_at,
      updated_at = NOW()`,
    [
      user.id,
      user.email,
      firstName,
      lastName,
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
 * Update user details across all their memberships.
 * Reads the resolved name from the users table (which may have been enriched
 * from Slack) rather than using raw WorkOS data that might be empty.
 */
async function updateUserAcrossMemberships(user: UserData): Promise<void> {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE organization_memberships om
     SET email = $1,
         first_name = COALESCE(NULLIF(TRIM(u.first_name), ''), om.first_name),
         last_name = COALESCE(NULLIF(TRIM(u.last_name), ''), om.last_name),
         synced_at = NOW(),
         updated_at = NOW()
     FROM users u
     WHERE u.workos_user_id = $2
       AND om.workos_user_id = $2`,
    [user.email, user.id]
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
async function upsertOrganizationDomain(domainData: OrganizationDomainEventData & { domain: string }): Promise<void> {
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

    // Sync the brand registry: if WorkOS just confirmed the domain is owned
    // by this org, mirror ownership + verified flags into the brands row
    // (#3176). Use the sync-only method — NOT applyVerifiedBrandClaim —
    // because the webhook doesn't know the user's adopt-vs-fresh decision
    // and would otherwise clobber a manifest the inline /verify route
    // intentionally adopted seconds earlier.
    //
    // For dashboard-flipped domains (admin marked verified directly in the
    // WorkOS console, no inline /verify call), this path is the ONLY writer.
    // A failure here means the brand row will lag the WorkOS state until the
    // next event for this domain — investigate logs if it surfaces.
    if (domainData.state === 'verified') {
      try {
        const brandDb = new BrandDatabase();
        await brandDb.markBrandDomainVerified(normalizedDomain, domainData.organization_id);
        logger.info({
          orgId: domainData.organization_id,
          domain: normalizedDomain,
        }, 'Synced verified domain to brand registry');
      } catch (err) {
        // Don't block the webhook on brand-registry sync errors — webhook
        // idempotency is the whole point. Subsequent events will retry.
        logger.error({ err, orgId: domainData.organization_id, domain: normalizedDomain }, 'Failed to sync verified domain to brand registry');
      }
    }
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
async function deleteSingleOrganizationDomain(domainData: OrganizationDomainEventData & { domain: string }): Promise<void> {
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
          await getWorkos().webhooks.constructEvent({
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
                workosUser = await getWorkos().userManagement.getUser(membership.user_id);
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
            // Fire-and-forget prospect triage + brand research for business emails.
            if (user.email) {
              const domain = user.email.split('@')[1];
              if (domain) {
                // Assess prospect value and notify Slack
                if (process.env.ANTHROPIC_API_KEY) {
                  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
                  trackBackground(
                    triageAndNotify(domain, { name, email: user.email, source: 'inbound' }).catch(err => {
                      logger.error({ err, domain }, 'Prospect triage failed for new website user');
                    })
                  );
                }
                // Classify brand hierarchy before the user finishes onboarding
                const isValidDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)
                  && !(/^\d+\.\d+\.\d+\.\d+$/.test(domain));
                if (isValidDomain && !isFreeEmailDomain(domain)) {
                  trackBackground(
                    researchDomain(domain).catch(err => {
                      logger.warn({ err, domain }, 'Background domain research failed for new user');
                    })
                  );
                }
              }
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
              trackBackground(
                researchDomain(primaryDomain, { org_id: newOrg.id }).catch(err => {
                  logger.warn({ err, orgId: newOrg.id, domain: primaryDomain }, 'Background research failed for new org');
                })
              );
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
          case 'organization_domain.verified':
          case 'organization_domain.deleted':
          case 'organization_domain.verification_failed': {
            const domainData = event.data as unknown as OrganizationDomainEventData;
            if (!domainData.domain) {
              logger.warn({ event: event.event, domainId: domainData.id, organizationId: domainData.organization_id }, 'Skipping domain event: missing domain field');
              break;
            }
            if (event.event === 'organization_domain.deleted' || event.event === 'organization_domain.verification_failed') {
              await deleteSingleOrganizationDomain(domainData as OrganizationDomainEventData & { domain: string });
            } else {
              await upsertOrganizationDomain(domainData as OrganizationDomainEventData & { domain: string });

              // Enqueue verified domains for adagents.json discovery
              if (event.event === 'organization_domain.verified') {
                const pool = getPool();
                pool.query(
                  `INSERT INTO catalog_crawl_queue (identifier_type, identifier_value)
                   VALUES ('domain', $1)
                   ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
                  [domainData.domain.toLowerCase().trim()]
                ).catch(err => {
                  logger.warn({ err, domain: domainData.domain }, 'Failed to enqueue domain for crawl');
                });
              }
            }
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
            const usersResponse = await getWorkos().userManagement.listUsers({
              organizationId: org.workos_organization_id,
              limit: 100,
              after,
            });

            for (const user of usersResponse.data) {
              try {
                // Get the membership ID for this user in this org
                const membershipsResponse = await getWorkos().userManagement.listOrganizationMemberships({
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
 * Two-pass enumeration: first lists all WorkOS users (catches users not in
 * any org), then lists users per org as a safety net. Removes local rows
 * for users confirmed deleted from WorkOS (verified via getUser).
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
    const processedUserIds = new Set<string>();

    // Upsert helper shared by both passes
    async function upsertUser(user: { id: string; email: string; firstName: string | null; lastName: string | null; emailVerified: boolean; createdAt: string; updatedAt: string }) {
      if (processedUserIds.has(user.id)) return;
      processedUserIds.add(user.id);

      try {
        await pool.query(
          `INSERT INTO users (
            workos_user_id, email, first_name, last_name,
            email_verified, workos_created_at, workos_updated_at,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (workos_user_id) DO UPDATE SET
            email = EXCLUDED.email,
            first_name = COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), users.first_name),
            last_name = COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), users.last_name),
            email_verified = EXCLUDED.email_verified,
            workos_updated_at = EXCLUDED.workos_updated_at,
            updated_at = NOW()`,
          [user.id, user.email, user.firstName, user.lastName,
           user.emailVerified, user.createdAt, user.updatedAt]
        );
        result.usersCreated++;
      } catch (userError) {
        logger.warn({ error: userError, userId: user.id }, 'Backfill: failed to upsert user');
        result.errors.push(`Failed to upsert user ${user.id}`);
      }
      result.usersProcessed++;
    }

    // Pass 1: Enumerate ALL WorkOS users (catches users not in any org)
    let pass1Complete = false;
    logger.info('Backfill: pass 1 — enumerating all WorkOS users');
    try {
      let after: string | undefined;
      do {
        const usersResponse = await getWorkos().userManagement.listUsers({
          limit: 100,
          after,
        });

        for (const user of usersResponse.data) {
          await upsertUser(user);
        }

        after = usersResponse.data.length === 100
          ? usersResponse.data[usersResponse.data.length - 1].id
          : undefined;
      } while (after);

      pass1Complete = true;
      logger.info({ count: processedUserIds.size }, 'Backfill: pass 1 complete');
    } catch (pass1Err) {
      result.errors.push(`Pass 1 enumeration failed partway through`);
      logger.error({ error: pass1Err, usersFoundSoFar: processedUserIds.size }, 'Backfill: pass 1 failed, deletion phase will be skipped');
    }

    // Pass 2: Enumerate users per org as a safety net. In practice,
    // pass 1 covers all users; this guards against undocumented
    // WorkOS pagination inconsistencies.
    logger.info('Backfill: pass 2 — enumerating users per org');
    const orgsResult = await pool.query(
      `SELECT workos_organization_id FROM organizations`
    );

    const BATCH_SIZE = 10;
    const orgs = orgsResult.rows;

    for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
      const batch = orgs.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (org) => {
        try {
          let orgAfter: string | undefined;
          do {
            const usersResponse = await getWorkos().userManagement.listUsers({
              organizationId: org.workos_organization_id,
              limit: 100,
              after: orgAfter,
            });

            for (const user of usersResponse.data) {
              await upsertUser(user);
            }

            orgAfter = usersResponse.data.length === 100
              ? usersResponse.data[usersResponse.data.length - 1].id
              : undefined;
          } while (orgAfter);
        } catch (orgError) {
          logger.warn({ error: orgError, orgId: org.workos_organization_id }, 'Backfill: failed to fetch org users');
          result.errors.push(`Failed to fetch users for org ${org.workos_organization_id}`);
        }
      }));
    }

    logger.info({ count: processedUserIds.size }, 'Backfill: pass 2 complete');

    // Remove local users that no longer exist in WorkOS.
    // Only safe when pass 1 completed fully — a partial enumeration
    // would produce false deletion candidates.
    if (pass1Complete && processedUserIds.size > 0) {
      const localUsers = await pool.query<{ workos_user_id: string }>(
        `SELECT workos_user_id FROM users`,
      );

      const candidates = localUsers.rows.filter(
        row => !processedUserIds.has(row.workos_user_id)
      );

      logger.info({ count: candidates.length }, 'Backfill: verifying deletion candidates against WorkOS');

      // Process candidates sequentially to avoid pool connection deadlock.
      // Each iteration may acquire a pool connection for the DELETE transaction,
      // and the pool max is small (3). Using Promise.all with a batch size > pool
      // max would cause all connections to be held simultaneously, blocking any
      // new connect() calls and deadlocking.
      for (const row of candidates) {
        try {
          // Confirm the user is actually gone from WorkOS before deleting
          await getWorkos().userManagement.getUser(row.workos_user_id);
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
            // WorkOS API error — don't delete, log full error server-side only
            logger.warn({ error: getErr, userId: row.workos_user_id }, 'Backfill: WorkOS API error during user verification');
            result.errors.push(`Could not verify user ${row.workos_user_id}: WorkOS API error (status ${getErr?.status || 'unknown'})`);
            result.usersSkipped++;
          }
        }
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
          const workosOrg = await getWorkos().organizations.getOrganization(org.workos_organization_id);

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
