import type { WorkOSUser } from '../../src/types.js';
import { loadAuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

/** Legacy policy fixtures inject authentication. Give those fixtures the same
 * server-only stamp as auth; real cookie/JWT verification is tested separately.
 */
export async function stampOrganizationTestUser(user: WorkOSUser, organizationId: string): Promise<void> {
  const snapshot = await loadAuthorizationSnapshot(user.id, organizationId);
  if (!snapshot) throw new Error('Test credential has no authorization snapshot');
  user.identityId = snapshot.identityId ?? undefined;
  Object.defineProperty(user, 'authorizationSnapshot', { value: snapshot });
}
