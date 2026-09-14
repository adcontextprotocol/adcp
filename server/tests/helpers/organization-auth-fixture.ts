import type { WorkOSUser } from '../../src/types.js';
import { getPool } from '../../src/db/client.js';
import { stampOrganizationAuthentication } from '../../src/auth/organization-principal.js';

/** Legacy policy fixtures inject authentication. Give those fixtures the same
 * server-only stamp as auth; real cookie/JWT verification is tested separately.
 */
export async function stampOrganizationTestUser(user: WorkOSUser): Promise<void> {
  const result = await getPool().query(
    `SELECT iwu.identity_id, iwu.xmin::text AS binding_version, ae.epoch::text AS epoch
       FROM (SELECT 1) anchor
       LEFT JOIN identity_workos_users iwu ON iwu.workos_user_id = $1
       LEFT JOIN authorization_epochs ae ON ae.workos_user_id = $1`, [user.id],
  );
  const row = result.rows[0];
  user.identityId = row.identity_id;
  stampOrganizationAuthentication(user, { credentialId: user.id, canonicalUserId: user.id, identityId: row.identity_id, bindingVersion: row.binding_version, epoch: row.epoch });
}
