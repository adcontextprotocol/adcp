import type { Request } from 'express';

export class ConflictingOrganizationSelectionError extends Error {}

/** Every explicit selector must agree with the authenticated provider selection.
 * Request fields cannot switch an organization-bound credential to another org.
 * Neither memberships nor caches pick an organization. */
export function selectedOrganizationForAuthentication(
  req: Partial<Pick<Request, 'headers' | 'query' | 'body' | 'params'>>,
  providerOrg?: string,
): string | null {
  const selectors = [
    providerOrg,
    req.headers?.['x-organization-id'], req.query?.org, req.query?.org_id, req.query?.organization_id, req.query?.organizationId,
    req.body?.org_id, req.body?.organization_id, req.body?.organizationId,
    req.params?.org_id, req.params?.orgId, req.params?.organizationId,
  ].filter((value) => value !== undefined);
  if (selectors.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new ConflictingOrganizationSelectionError();
  }
  const ids = new Set(selectors.map((value) => (value as string).trim()));
  if (ids.size > 1) throw new ConflictingOrganizationSelectionError();
  return ids.values().next().value ?? null;
}
