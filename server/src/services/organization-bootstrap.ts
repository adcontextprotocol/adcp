/**
 * Organization creation/adoption is suspended until the explicit first-owner
 * flow can bind immutable credential proof, current verified domain state,
 * consent, and a durable operation to serialized membership/audit/epoch writes.
 * Never recover ownership implicitly from email or a canonical person ID.
 */
import type { WorkOS } from '@workos-inc/node';
import type { OrganizationDatabase } from '../db/organization-db.js';

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
  | { kind: 'onboarding_disabled' }
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
  _input: CreateOrgRequest,
  _deps: { workos: WorkOS | null; orgDb: OrganizationDatabase },
): Promise<CreateOrgOutcome> {
  return { kind: 'onboarding_disabled' };
}
