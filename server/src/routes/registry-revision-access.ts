/**
 * Registry edit history is read by two different audiences, and they are not
 * entitled to the same row.
 *
 * The public registry viewers (`property-viewer.html`, `brand-viewer.html`)
 * render a Wikipedia-style changelog: which revision, when, what the summary
 * said, who to credit. They never read the stored snapshot — the current
 * record comes from the record's own endpoint — so the list endpoints serve
 * the projection below and nothing else.
 *
 * The stored snapshot is a copy of the registry row and is served only to
 * the record's owner org or an AAO admin, through the single-revision
 * endpoint. That snapshot is allowlisted as well
 * (`db/registry-revision-snapshot.ts`); the authorization here is the outer
 * of the two bounds, not the only one.
 */

import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import type { OrgAuthorizationPrincipal } from '../auth/organization-principal.js';
import { resolveUserOrgAuthorization } from '../utils/resolve-user-org-authorization.js';
import type { RegistryRevision } from '../types.js';

/**
 * `edit_summary` is attacker-controlled free text with no cap on the write
 * path, and this projection is served unauthenticated at up to 100 revisions
 * a page. The viewers escape it, so the concern is volume rather than
 * injection: without a bound here one edit sets the size of every public
 * changelog response for that domain, forever.
 */
const PUBLIC_EDIT_SUMMARY_MAX = 1_000;

export interface PublicRegistryRevision {
  id: string;
  domain: string;
  revision_number: number;
  /** Truncated to {@link PUBLIC_EDIT_SUMMARY_MAX}. */
  edit_summary: string;
  /** See {@link publicEditorName} — omitted when there is no safe name. */
  editor_name?: string;
  is_rollback: boolean;
  rolled_back_to?: number;
  created_at: Date;
}

/**
 * The editor display name a public changelog may publish, or `undefined`.
 *
 * Editors whose profile carried no display name were recorded under their
 * email address (`editor_name: displayName || email`), so an address-shaped
 * value is dropped rather than published: public attribution is a name, never
 * a way to reach someone.
 */
export function publicEditorName(editorName: unknown): string | undefined {
  const name = typeof editorName === 'string' ? editorName.trim() : '';
  return name && !name.includes('@') ? name : undefined;
}

export function toPublicRegistryRevision(revision: RegistryRevision): PublicRegistryRevision {
  const editorName = publicEditorName(revision.editor_name);
  return {
    id: revision.id,
    domain: revision.domain,
    revision_number: revision.revision_number,
    edit_summary: typeof revision.edit_summary === 'string'
      ? revision.edit_summary.slice(0, PUBLIC_EDIT_SUMMARY_MAX)
      : revision.edit_summary,
    ...(editorName ? { editor_name: editorName } : {}),
    is_rollback: revision.is_rollback ?? false,
    ...(revision.rolled_back_to !== undefined && revision.rolled_back_to !== null
      ? { rolled_back_to: revision.rolled_back_to }
      : {}),
    created_at: revision.created_at,
  };
}

/** The owner columns a registry row carries, as far as revision access cares. */
export interface RegistryRecordOwner {
  workos_organization_id?: string | null;
  created_by_user_id?: string | null;
}

/**
 * `unavailable` is not `forbidden`: an authorization source that is down must
 * surface as 503, so a WorkOS outage does not read to the record's own owner
 * as "you don't own this".
 */
export type RegistryRevisionAccess = 'authorized' | 'forbidden' | 'unavailable';

/**
 * Whether a caller may read a registry record's stored revision snapshots.
 * Admins are handled by the caller, which already holds the AAO admin lookup
 * and its authorization-outage response.
 *
 * Two grants:
 *
 *  - The user who created the record. This mirrors the existing delete route
 *    (`DELETE /api/properties/hosted/:domain`), and it outlives leaving the
 *    owning org — a personal grant over the content history of a record you
 *    wrote, not over anything the org owns. The snapshots are allowlisted, so
 *    what it reaches is edit content, not ownership state.
 *  - A member of the owning org, resolved through the repo's organization
 *    boundary (`resolveUserOrgAuthorization`) rather than the
 *    `organization_memberships` mirror. The mirror is webhook-synced, so a
 *    user removed from the org upstream would keep access until the next
 *    sync, and a sync outage would read as a clean denial.
 *
 *    Narrower than it sounds: the resolver compares the record's owning org
 *    against the session's *selected* organization, so a multi-org user
 *    sitting in org X is refused a record owned by org Y even while an
 *    active member of Y. Switching session org is the way through. Erring
 *    narrow is the right default on a surface that had no authorization at
 *    all until now.
 *
 * API-key principals qualify for neither grant. An org-bound key's synthetic
 * principal carries `id: api_key_<id>` and no WorkOS user, and the static
 * `ADMIN_API_KEY` principal carries `id: admin_api_key`; neither has an
 * authorization snapshot, so both are refused — as they are on the sibling
 * admin-gated registry routes. Widening to `req.apiKey.organizationId` is a
 * later decision with a caller behind it.
 */
export async function resolveRegistryRevisionAccess(
  user: Partial<OrgAuthorizationPrincipal> | undefined,
  owner: RegistryRecordOwner | null | undefined,
): Promise<RegistryRevisionAccess> {
  if (!user?.id || !owner) return 'forbidden';
  if (owner.created_by_user_id && owner.created_by_user_id === user.id) return 'authorized';
  if (!owner.workos_organization_id) return 'forbidden';

  const authorization = await resolveUserOrgAuthorization(
    getAuthorizationEnforcementWorkos(),
    user as OrgAuthorizationPrincipal,
    owner.workos_organization_id,
  );
  return authorization.status === 'authorized' ? 'authorized'
    : authorization.status === 'unavailable' ? 'unavailable'
      : 'forbidden';
}
