/**
 * WorkOS webhook routes
 *
 * Handles incoming webhooks from WorkOS for user and organization membership events.
 * Used to keep local organization_memberships table in sync for fast user search.
 *
 * Events handled:
 * - user.created, user.updated, user.deleted
 * - organization_membership.created, organization_membership.updated, organization_membership.deleted
 *
 * Setup in WorkOS Dashboard:
 * 1. Go to Developers > Webhooks
 * 2. Add endpoint: https://your-domain/api/webhooks/workos
 * 3. Select events: user.*, organization_membership.*
 * 4. Copy the signing secret to WORKOS_WEBHOOK_SECRET env var
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createLogger } from '../logger.js';
import { getPool } from '../db/client.js';
import { workos } from '../auth/workos-client.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';

const logger = createLogger('workos-webhooks');

const WORKOS_WEBHOOK_SECRET = process.env.WORKOS_WEBHOOK_SECRET;

/**
 * WorkOS webhook event types
 */
interface WorkOSWebhookEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  created_at: string;
}

interface OrganizationMembershipData {
  id: string;
  user_id: string;
  organization_id: string;
  status: 'active' | 'pending' | 'inactive';
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

/**
 * Verify WorkOS webhook signature
 * WorkOS uses HMAC SHA256 with the webhook secret
 */
function verifyWorkOSWebhook(
  payload: string,
  signature: string | undefined,
  timestamp: string | undefined
): boolean {
  if (!WORKOS_WEBHOOK_SECRET) {
    logger.warn('WORKOS_WEBHOOK_SECRET not configured, skipping signature verification (dev mode)');
    return true;
  }

  if (!signature || !timestamp) {
    logger.warn({ hasSignature: !!signature, hasTimestamp: !!timestamp }, 'Missing WorkOS webhook headers');
    return false;
  }

  try {
    // WorkOS signature format: t=timestamp,v1=signature
    const expectedSignature = crypto
      .createHmac('sha256', WORKOS_WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    // Extract the v1 signature from the header
    const signatureMatch = signature.match(/v1=([a-f0-9]+)/);
    if (!signatureMatch) {
      logger.warn({ signature }, 'Invalid WorkOS signature format');
      return false;
    }

    const providedSignature = signatureMatch[1];
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );

    if (!isValid) {
      logger.warn('WorkOS webhook signature mismatch');
    }

    return isValid;
  } catch (error) {
    logger.error({ error }, 'Error verifying WorkOS webhook signature');
    return false;
  }
}

/**
 * Upsert organization membership to local database
 */
async function upsertMembership(
  membership: OrganizationMembershipData,
  user?: UserData
): Promise<void> {
  const pool = getPool();

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

  await pool.query(
    `INSERT INTO organization_memberships (
      workos_user_id,
      workos_organization_id,
      workos_membership_id,
      email,
      first_name,
      last_name,
      synced_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (workos_user_id, workos_organization_id)
    DO UPDATE SET
      workos_membership_id = EXCLUDED.workos_membership_id,
      email = EXCLUDED.email,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      synced_at = NOW(),
      updated_at = NOW()`,
    [
      membership.user_id,
      membership.organization_id,
      membership.id,
      userData.email,
      userData.first_name,
      userData.last_name,
    ]
  );

  logger.info({
    membershipId: membership.id,
    userId: membership.user_id,
    orgId: membership.organization_id,
  }, 'Upserted organization membership');
}

/**
 * Delete organization membership from local database
 */
async function deleteMembership(membership: OrganizationMembershipData): Promise<void> {
  const pool = getPool();

  await pool.query(
    `DELETE FROM organization_memberships
     WHERE workos_user_id = $1 AND workos_organization_id = $2`,
    [membership.user_id, membership.organization_id]
  );

  logger.info({
    membershipId: membership.id,
    userId: membership.user_id,
    orgId: membership.organization_id,
  }, 'Deleted organization membership');
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
 * Create WorkOS webhooks router
 */
export function createWorkOSWebhooksRouter(): Router {
  const router = Router();

  router.post(
    '/workos',
    // Custom middleware to capture raw body for signature verification
    (req: Request, res: Response, next) => {
      let rawBody = '';
      req.setEncoding('utf8');

      req.on('data', (chunk: string) => {
        rawBody += chunk;
      });

      req.on('end', () => {
        (req as Request & { rawBody: string }).rawBody = rawBody;
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
        const rawBody = (req as Request & { rawBody: string }).rawBody;
        const signature = req.headers['workos-signature'] as string | undefined;
        const timestamp = signature?.match(/t=(\d+)/)?.[1];

        logger.info({ bodyLength: rawBody.length, event: req.body?.event }, 'Received WorkOS webhook');

        if (!verifyWorkOSWebhook(rawBody, signature, timestamp)) {
          logger.warn('Rejecting WorkOS webhook: invalid signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const event = req.body as WorkOSWebhookEvent;

        switch (event.event) {
          case 'organization_membership.created':
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

          case 'user.updated': {
            const user = event.data as unknown as UserData;
            await updateUserAcrossMemberships(user);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'user.deleted': {
            const user = event.data as unknown as UserData;
            await deleteUserMemberships(user.id);
            invalidateUnifiedUsersCache();
            break;
          }

          case 'user.created': {
            // User created doesn't necessarily mean they have a membership yet
            // We'll get organization_membership.created when they join an org
            logger.debug({ userId: (event.data as unknown as UserData).id }, 'User created event (no action needed)');
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
        logger.error({ error, durationMs }, 'Error processing WorkOS webhook');
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return router;
}

/**
 * Backfill organization memberships from WorkOS
 * Call this to populate the table initially or to resync
 */
export async function backfillOrganizationMemberships(): Promise<{
  orgsProcessed: number;
  membershipsCreated: number;
  errors: string[];
}> {
  const pool = getPool();
  const result = {
    orgsProcessed: 0,
    membershipsCreated: 0,
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
                // Also get the membership to get the membership ID
                const membershipsResponse = await workos.userManagement.listOrganizationMemberships({
                  userId: user.id,
                  organizationId: org.workos_organization_id,
                });

                const membership = membershipsResponse.data[0];
                if (membership && membership.status === 'active') {
                  await pool.query(
                    `INSERT INTO organization_memberships (
                      workos_user_id,
                      workos_organization_id,
                      workos_membership_id,
                      email,
                      first_name,
                      last_name,
                      synced_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
                    ON CONFLICT (workos_user_id, workos_organization_id)
                    DO UPDATE SET
                      workos_membership_id = EXCLUDED.workos_membership_id,
                      email = EXCLUDED.email,
                      first_name = EXCLUDED.first_name,
                      last_name = EXCLUDED.last_name,
                      synced_at = NOW(),
                      updated_at = NOW()`,
                    [
                      user.id,
                      org.workos_organization_id,
                      membership.id,
                      user.email,
                      user.firstName,
                      user.lastName,
                    ]
                  );
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

          result.orgsProcessed++;
        } catch (orgError) {
          const msg = `Failed to process org ${org.workos_organization_id}: ${orgError}`;
          result.errors.push(msg);
          logger.warn({ error: orgError, orgId: org.workos_organization_id }, 'Backfill: failed to process org');
        }
      }));
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
