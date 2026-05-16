/**
 * Service: bootstrap a WorkOS organization + local org row + email-verified
 * domain + ToS / privacy acceptance + audit log + marketing opt-in for the
 * authenticated caller.
 *
 * Two callers share this:
 *
 * 1. `POST /api/organizations` — the dashboard's onboarding form and the
 *    public storefront-style entry point. Caller picks `organization_name`
 *    and (for company orgs) supplies `company_type` / `revenue_tier`.
 *
 * 2. `POST /api/me/agents` — auto-bootstrap when the caller has zero
 *    memberships. The route derives sensible defaults (personal vs
 *    corporate based on email, name from domain or `${first} {last}'s
 *    Workspace`) and lands an org so the agent registration can proceed
 *    without a separate round trip.
 *
 * Tier (`membership_tier`) and corporate domain (`corporate_domain`) are
 * **not** caller-controlled. Tier is owned exclusively by the Stripe
 * webhook (`http.ts:3904`); domain is derived from `user.email` here.
 */

import { WorkOS } from '@workos-inc/node';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { OrganizationDatabase, CompanyType, RevenueTier, VALID_REVENUE_TIERS } from '../db/organization-db.js';
import { linkDomain } from '../db/organization-domains-db.js';
import { COMPANY_TYPE_VALUES } from '../config/company-types.js';
import { validateOrganizationName } from '../middleware/validation.js';
import { getCompanyDomain } from '../utils/email-domain.js';
import { emailPrefsDb } from '../db/email-preferences-db.js';

const logger = createLogger('organization-bootstrap');

export interface CreateOrgRequest {
  user: { id: string; email: string };
  organization_name: string;
  is_personal: boolean;
  company_type?: string;
  revenue_tier?: string;
  marketing_opt_in?: boolean;
  /**
   * Whether the request is from a dev-mode user. The route handler computes
   * this via `isDevModeEnabled() && getDevUser(req)`; auto-bootstrap callers
   * should pass `false` since dev mode is a dashboard-form concern.
   */
  isDevUser: boolean;
  /**
   * Request-side context recorded with ToS / privacy acceptance.
   */
  requestContext: { ip: string; userAgent: string };
}

/**
 * Discriminated outcome. The caller maps the kind to an HTTP status.
 *
 * `created` and `adopted` are the success paths; everything else is a
 * domain-level failure that callers may translate into 4xx.
 */
export type CreateOrgOutcome =
  | { kind: 'created'; orgId: string; name: string }
  | { kind: 'adopted'; orgId: string; name: string }
  | { kind: 'org_limit_reached' }
  | { kind: 'personal_workspace_exists' }
  | { kind: 'missing_organization_name' }
  | { kind: 'invalid_organization_name'; message: string }
  | { kind: 'invalid_company_type' }
  | { kind: 'invalid_revenue_tier' }
  | { kind: 'corporate_email_required' }
  | { kind: 'domain_taken'; existingOrgId: string; existingOrgName: string; domain: string };

export async function performCreateOrganization(
  input: CreateOrgRequest,
  deps: { workos: WorkOS | null; orgDb: OrganizationDatabase },
): Promise<CreateOrgOutcome> {
  const {
    user,
    organization_name,
    is_personal,
    company_type,
    revenue_tier,
    marketing_opt_in,
    isDevUser,
    requestContext,
  } = input;
  const { workos, orgDb } = deps;
  const pool = getPool();

  // Per-user org-count cap.
  const orgCountResult = await pool.query(
    `SELECT COUNT(*) AS count FROM organization_memberships WHERE workos_user_id = $1`,
    [user.id],
  );
  const orgCount = parseInt(orgCountResult.rows[0].count, 10);
  if (orgCount >= 10) return { kind: 'org_limit_reached' };

  // Personal-workspace uniqueness.
  if (is_personal) {
    const existingPersonal = await pool.query(
      `SELECT 1 FROM organization_memberships om
       JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
       WHERE om.workos_user_id = $1 AND o.is_personal = true
       LIMIT 1`,
      [user.id],
    );
    if (existingPersonal.rows.length > 0) return { kind: 'personal_workspace_exists' };
  }

  if (!organization_name) return { kind: 'missing_organization_name' };

  const nameValidation = validateOrganizationName(organization_name);
  if (!nameValidation.valid) {
    return { kind: 'invalid_organization_name', message: nameValidation.error || 'invalid' };
  }

  if (company_type && !COMPANY_TYPE_VALUES.includes(company_type as any)) {
    return { kind: 'invalid_company_type' };
  }
  if (revenue_tier && !(VALID_REVENUE_TIERS as readonly string[]).includes(revenue_tier)) {
    return { kind: 'invalid_revenue_tier' };
  }

  const userEmailDomain = getCompanyDomain(user.email);
  let verifiedDomain: string | null = null;

  if (!is_personal) {
    if (!userEmailDomain) return { kind: 'corporate_email_required' };
    verifiedDomain = userEmailDomain;
  }

  const trimmedName = organization_name.trim();

  // Domain-already-claimed branch — adopt prospects, conflict on actives.
  if (verifiedDomain) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingOrgResult = await client.query(
        `SELECT o.workos_organization_id, o.name, o.prospect_status, o.subscription_status
         FROM organization_domains od
         JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
         WHERE LOWER(od.domain) = LOWER($1)
         FOR UPDATE OF o`,
        [verifiedDomain],
      );

      if (existingOrgResult.rows.length > 0) {
        const existing = existingOrgResult.rows[0];
        const existingOrgId = existing.workos_organization_id;
        const existingOrgName = existing.name;

        const isAdoptable = !existing.subscription_status
          && (!existing.prospect_status || !['joined', 'declined'].includes(existing.prospect_status));

        if (!isAdoptable) {
          await client.query('ROLLBACK');
          return {
            kind: 'domain_taken',
            existingOrgId,
            existingOrgName,
            domain: verifiedDomain,
          };
        }

        // Release the FOR UPDATE before WorkOS network round-trips.
        await client.query('COMMIT');

        let existingMembership: { id: string; role?: { slug: string } } | null = null;
        if (!isDevUser) {
          const userMemberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
            organizationId: existingOrgId,
            statuses: ['active', 'inactive', 'pending'],
          });
          existingMembership = userMemberships.data[0] ?? null;
        }
        const alreadyMember = !!existingMembership;
        const roleSlug = 'owner';

        if (existingMembership && existingMembership.role?.slug !== 'owner') {
          await workos!.userManagement.updateOrganizationMembership(existingMembership.id, {
            roleSlug: 'owner',
          });
        }

        logger.info({
          userId: user.id,
          orgId: existingOrgId,
          orgName: existingOrgName,
          domain: verifiedDomain,
          role: roleSlug,
          wasAlreadyMember: alreadyMember,
        }, 'User adopting prospect organization');

        if (!alreadyMember && !isDevUser) {
          await workos!.userManagement.createOrganizationMembership({
            userId: user.id,
            organizationId: existingOrgId,
            roleSlug,
          });
        }

        await client.query('BEGIN');

        await client.query(
          `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at, synced_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
           ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = $4, updated_at = NOW()`,
          [user.id, existingOrgId, user.email, roleSlug],
        );

        await client.query(
          `UPDATE organizations SET prospect_status = 'joined', updated_at = NOW()
           WHERE workos_organization_id = $1
             AND prospect_status IS NOT NULL
             AND prospect_status NOT IN ('joined', 'declined')`,
          [existingOrgId],
        );

        await orgDb.recordAuditLog({
          workos_organization_id: existingOrgId,
          workos_user_id: user.id,
          action: 'organization_adopted',
          resource_type: 'organization',
          resource_id: existingOrgId,
          details: { user_email: user.email, domain: verifiedDomain, role: roleSlug },
        });

        await client.query('COMMIT');

        await recordMarketingOptIn(user, marketing_opt_in);

        return { kind: 'adopted', orgId: existingOrgId, name: existingOrgName };
      }

      await client.query('ROLLBACK');
    } catch (adoptError) {
      await client.query('ROLLBACK').catch(() => {});
      throw adoptError;
    } finally {
      client.release();
    }
  }

  logger.info({
    organization_name: trimmedName,
    is_personal,
    company_type,
    revenue_tier,
    verifiedDomain,
  }, 'Creating WorkOS organization');

  let workosOrgId: string;
  let workosOrgName: string;

  if (isDevUser) {
    workosOrgId = `org_dev_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    workosOrgName = trimmedName;
    logger.info({ orgId: workosOrgId, name: trimmedName, devUser: user.email }, 'DEV MODE: Mock organization created (no WorkOS)');
  } else {
    const workosOrg = await workos!.organizations.createOrganization({ name: trimmedName });
    workosOrgId = workosOrg.id;
    workosOrgName = workosOrg.name;

    logger.info({ orgId: workosOrgId, name: trimmedName }, 'WorkOS organization created');

    const ownerMembership = await workos!.userManagement.createOrganizationMembership({
      userId: user.id,
      organizationId: workosOrgId,
      roleSlug: 'owner',
    });

    logger.info({ userId: user.id, orgId: workosOrgId }, 'User added as organization owner');

    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
       VALUES ($1, $2, $3, $4, 'owner', 'contributor', NOW(), NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = 'owner', workos_membership_id = $3, updated_at = NOW()`,
      [user.id, workosOrgId, ownerMembership.id, user.email],
    );
  }

  // Tier is intentionally not set here — Stripe webhook is the sole writer.
  const orgRecord = await orgDb.createOrganization({
    workos_organization_id: workosOrgId,
    name: trimmedName,
    is_personal: is_personal || false,
    company_type: (company_type as CompanyType) || undefined,
    revenue_tier: (revenue_tier as RevenueTier) || undefined,
  });

  logger.info({
    orgId: workosOrgId,
    company_type: orgRecord.company_type,
    revenue_tier: orgRecord.revenue_tier,
  }, 'Organization record created');

  if (verifiedDomain) {
    const result = await linkDomain({
      orgId: workosOrgId,
      domain: verifiedDomain,
      source: 'email_verification',
      verified: true,
      isPrimary: true,
    });
    if (result.inserted) {
      logger.info({ orgId: workosOrgId, domain: verifiedDomain }, 'Corporate domain auto-verified via email');
    }
  }

  await orgDb.recordAuditLog({
    workos_organization_id: workosOrgId,
    workos_user_id: user.id,
    action: 'organization_created',
    resource_type: 'organization',
    resource_id: workosOrgId,
    details: {
      name: trimmedName,
      is_personal: is_personal || false,
      company_type: company_type || null,
      revenue_tier: revenue_tier || null,
    },
  });

  const tosAgreement = await orgDb.getCurrentAgreementByType('terms_of_service');
  const privacyAgreement = await orgDb.getCurrentAgreementByType('privacy_policy');

  if (tosAgreement) {
    await orgDb.recordUserAgreementAcceptance({
      workos_user_id: user.id,
      email: user.email,
      agreement_type: 'terms_of_service',
      agreement_version: tosAgreement.version,
      ip_address: requestContext.ip,
      user_agent: requestContext.userAgent,
      workos_organization_id: workosOrgId,
    });
  }
  if (privacyAgreement) {
    await orgDb.recordUserAgreementAcceptance({
      workos_user_id: user.id,
      email: user.email,
      agreement_type: 'privacy_policy',
      agreement_version: privacyAgreement.version,
      ip_address: requestContext.ip,
      user_agent: requestContext.userAgent,
      workos_organization_id: workosOrgId,
    });
  }

  await recordMarketingOptIn(user, marketing_opt_in);

  return { kind: 'created', orgId: workosOrgId, name: workosOrgName };
}

async function recordMarketingOptIn(user: { id: string; email: string }, optIn: boolean | undefined) {
  if (typeof optIn !== 'boolean') return;
  try {
    await emailPrefsDb.setMarketingOptInIfNotSet({
      workos_user_id: user.id,
      email: user.email,
      optIn,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to record marketing opt-in');
  }
}
