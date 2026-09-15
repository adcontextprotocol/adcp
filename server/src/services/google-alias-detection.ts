import { getPool } from '../db/client.js';
import { getGoogleEmailAliases } from '../utils/email-domain.js';

interface Credential {
  id: string;
  email: string;
}

// Deliberately expose only provider reads: mailbox equivalence cannot grant
// organization membership or permission to bind another sign-in credential.
interface AliasProvider {
  listUsers(options: { email: string }): Promise<{ data: Credential[] }>;
}

/**
 * Detect a possible duplicate for the support notice, retaining ID-only audit
 * evidence. Do not claim an email alias or bind identities here: canonical
 * identity routing would let either credential inherit the other's authority.
 */
export async function detectGoogleAliasAccount(
  credential: Credential,
  provider: AliasProvider,
): Promise<string | null> {
  const aliases = getGoogleEmailAliases(credential.email);
  if (aliases.length === 0) return null;

  const pool = getPool();
  const local = await pool.query<{ workos_user_id: string; email: string }>(
    `SELECT workos_user_id, email FROM users
      WHERE LOWER(email) = ANY($1::text[]) AND workos_user_id <> $2
      ORDER BY workos_user_id LIMIT 1`,
    [aliases, credential.id],
  );
  let duplicate = local.rows[0]
    ? { id: local.rows[0].workos_user_id, email: local.rows[0].email }
    : undefined;

  if (!duplicate) {
    for (const email of aliases) {
      const users = await provider.listUsers({ email });
      duplicate = users.data.find((user) => user.id !== credential.id);
      if (duplicate) break;
    }
  }
  if (!duplicate) return null;

  await pool.query(
    `INSERT INTO registry_audit_log
       (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
     VALUES ('system', $1, 'google_alias_detected', 'user', $2, $3)`,
    [credential.id, duplicate.id, JSON.stringify({ outcome: 'support_review_required' })],
  );
  return duplicate.email;
}
