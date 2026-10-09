/**
 * Organization merge containment (#6827)
 *
 * Organization merge deletes the secondary organization. It removes the local
 * organization row inside its transaction, commits, and only then asks WorkOS
 * to delete the provider organization, downgrading a provider failure to a
 * warning while still reporting success. The Addie path additionally attempts
 * the provider delete twice with WorkOS membership writes interleaved between
 * the local commit and the second attempt.
 *
 * That is the same split provider/local state the organization deletion
 * containment closed, so merge execution is unavailable on the same terms and
 * for the same reason. See docs/contributing/organization-deletion-containment.md
 * for the lifecycle contract a future implementation must satisfy.
 *
 * This module is the single source of truth for the refusal so the HTTP route,
 * the Addie tool and the shared service boundary cannot drift apart. It holds
 * no state, reads nothing and performs no I/O.
 *
 * It is deliberately separate from org-merge-db.ts rather than folded into it:
 * tests/addie/admin-tools.test.ts replaces org-merge-db.js with an explicit
 * factory mock exposing only mergeOrganizations and previewMerge, so importing
 * these constants into admin-tools.ts from there would fail that suite with
 * "No export is defined on the mock".
 */

/** Stable machine-readable code, mirroring `organization_deletion_unavailable`. */
export const ORGANIZATION_MERGE_UNAVAILABLE_ERROR = 'organization_merge_unavailable';

/** Stable human-readable message, mirroring the deletion containment wording. */
export const ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE =
  'Organization merge is temporarily unavailable.';

/**
 * Thrown by the shared merge service boundary. Callers that cannot return an
 * HTTP body (the Addie tool, scripts, any future caller) get a typed error
 * carrying the same stable code as the route response.
 */
export class OrganizationMergeUnavailableError extends Error {
  readonly code = ORGANIZATION_MERGE_UNAVAILABLE_ERROR;

  constructor() {
    super(ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE);
    this.name = 'OrganizationMergeUnavailableError';
  }
}

/**
 * The body the contained HTTP surface returns. The Addie tool returns markdown
 * carrying the same code and message, not this object.
 */
export function organizationMergeUnavailableBody() {
  return {
    error: ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
    message: ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
  } as const;
}
