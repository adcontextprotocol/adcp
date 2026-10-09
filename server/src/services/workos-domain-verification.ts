import type { WorkOS } from '@workos-inc/node';

type OrganizationDomain = Awaited<
  ReturnType<WorkOS['organizationDomains']['getOrganizationDomain']>
>;

export type WorkosDomainVerificationResult =
  | { status: 'verified'; domain: OrganizationDomain; newlyVerified: boolean }
  | { status: 'pending'; domain: OrganizationDomain };

export class WorkosDomainOwnershipMismatchError extends Error {
  constructor() {
    super('WorkOS returned a domain resource outside the requested organization or domain');
    this.name = 'WorkosDomainOwnershipMismatchError';
  }
}

function isVerified(state: unknown): boolean {
  return state === 'verified' || state === 'legacy_verified';
}

function assertExpectedDomain(
  candidate: OrganizationDomain,
  expected: { id: string; organizationId: string; domain: string },
): OrganizationDomain {
  if (
    candidate.id !== expected.id
    || candidate.organizationId !== expected.organizationId
    || candidate.domain.toLowerCase() !== expected.domain.toLowerCase()
  ) {
    throw new WorkosDomainOwnershipMismatchError();
  }
  return candidate;
}

function isPendingVerificationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.response?.status;
  return status === 400 || status === 422;
}

/**
 * Verify one exact WorkOS domain resource and refresh it from the canonical
 * organization-domain endpoint before deciding that it is still pending.
 *
 * WorkOS organization responses embed domain snapshots. They are useful for
 * locating the resource but are not authoritative after a verify request. A
 * verify response (or a 400/422 from the verify endpoint) can race the state
 * transition, so this helper performs one fresh read. Every returned resource
 * is checked against the expected id, organization and domain before callers
 * may mirror it into local ownership state.
 */
export async function verifyAndRefreshWorkosDomain(input: {
  workos: WorkOS;
  organizationId: string;
  domain: string;
  domainId: string;
}): Promise<WorkosDomainVerificationResult> {
  const expected = {
    id: input.domainId,
    organizationId: input.organizationId,
    domain: input.domain,
  };

  let verifyResult: OrganizationDomain | null = null;
  try {
    verifyResult = assertExpectedDomain(
      await input.workos.organizationDomains.verifyOrganizationDomain(input.domainId),
      expected,
    );
  } catch (error) {
    if (!isPendingVerificationError(error)) throw error;
  }

  if (verifyResult && isVerified(verifyResult.state)) {
    return { status: 'verified', domain: verifyResult, newlyVerified: true };
  }

  const refreshed = assertExpectedDomain(
    await input.workos.organizationDomains.getOrganizationDomain(input.domainId),
    expected,
  );
  if (isVerified(refreshed.state)) {
    return { status: 'verified', domain: refreshed, newlyVerified: true };
  }

  return { status: 'pending', domain: refreshed };
}
