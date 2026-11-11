/** Read-only legacy inventory for migration 595. Never resolve ownership by email. */
import { Client } from 'pg';

if (process.versions.unicode !== '17.0') throw new Error('Inventory requires Unicode 17.0 to match migration 595');
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly to a read-only database connection');
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // Refuse an incomplete RLS-filtered inventory instead of reporting it clean.
  await client.query('SET LOCAL row_security = off');
  const result = await client.query<{
    source: string; id: string; owner: string; email: string; identity_id: string | null;
  }>(`
    SELECT 'users' AS source, u.workos_user_id::text AS id,
      u.workos_user_id::text AS owner, u.email::text, b.identity_id
    FROM public.users u LEFT JOIN public.identity_workos_users b USING (workos_user_id)
    UNION ALL
    SELECT 'user_email_aliases', a.id::text, a.workos_user_id::text, a.email::text, b.identity_id
    FROM public.user_email_aliases a LEFT JOIN public.identity_workos_users b USING (workos_user_id)
  `);
  await client.query('COMMIT');
  const grouped = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const key = row.email.trim().toLowerCase();
    const rows = grouped.get(key) ?? [];
    rows.push(row); grouped.set(key, rows);
  }
  const overlaps = [...grouped].filter(([, rows]) => rows.length > 1).map(([email, rows]) => ({
    normalized_email: email,
    blocks_installation: new Set(rows.map(row => row.owner)).size > 1
      || rows.filter(row => row.source === 'user_email_aliases').length > 1,
    rows,
  }));
  console.log(JSON.stringify({ unicode_version: process.versions.unicode, row_count: result.rowCount,
    conflict_count: overlaps.filter(overlap => overlap.blocks_installation).length, overlaps }, null, 2));
  if (overlaps.some(overlap => overlap.blocks_installation)) process.exitCode = 1;
} finally {
  await client.end();
}
