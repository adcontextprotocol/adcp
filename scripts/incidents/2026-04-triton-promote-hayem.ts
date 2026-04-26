/**
 * Resolve escalation #285: promote raphael.hayem@tritondigital.com to admin
 * in the Triton Digital org (`org_01KC80TYK2QPPWQ7A8SGGGNHE7`).
 *
 * Walks the four states of POST /api/organizations/:orgId/members/by-email:
 *   - WorkOS user not found        -> sendInvitation as member; owner promotes after accept
 *   - User found, not a member     -> createOrganizationMembership as admin (Path 2)
 *   - User found, member           -> updateOrganizationMembership to admin (Path 3)
 *   - User found, already admin    -> no_change
 *
 * Defaults to --dry-run. Pass --execute to actually run the writes.
 *
 * Usage:
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/incidents/2026-04-triton-promote-hayem.ts            # dry run
 *
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/incidents/2026-04-triton-promote-hayem.ts --execute  # live
 */

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL?.replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_BASE_URL || !ADMIN_API_KEY) {
  console.error('ADMIN_BASE_URL and ADMIN_API_KEY env vars are required.');
  process.exit(1);
}

const TRITON_ORG_ID = process.env.TRITON_ORG_ID || 'org_01KC80TYK2QPPWQ7A8SGGGNHE7';
const TARGET_EMAIL = process.env.TARGET_EMAIL || 'raphael.hayem@tritondigital.com';
const TARGET_ROLE = process.env.TARGET_ROLE || 'admin';

const execute = process.argv.includes('--execute');

async function adminFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ADMIN_API_KEY}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  console.log(`Triton escalation #285 — promote ${TARGET_EMAIL} to ${TARGET_ROLE}`);
  console.log(`Org:    ${TRITON_ORG_ID}`);
  console.log(`Mode:   ${execute ? 'EXECUTE' : 'dry-run (no writes)'}`);
  console.log('');

  if (!execute) {
    console.log(`Would POST /api/organizations/${TRITON_ORG_ID}/members/by-email`);
    console.log(`     body: ${JSON.stringify({ email: TARGET_EMAIL, role: TARGET_ROLE })}`);
    console.log('');
    console.log(`Re-run with --execute to perform the call.`);
    return;
  }

  const result = await adminFetch<{
    success?: boolean;
    action?: string;
    message?: string;
    invited_role?: string;
    requested_role?: string;
    role?: string;
    previous_role?: string | null;
    user_id?: string;
    invitation?: { id: string; email: string; state: string; accept_invitation_url?: string };
    error?: string;
  }>(
    `/api/organizations/${encodeURIComponent(TRITON_ORG_ID)}/members/by-email`,
    {
      method: 'POST',
      body: JSON.stringify({ email: TARGET_EMAIL, role: TARGET_ROLE }),
    },
  );

  if (!result.ok || !result.body) {
    console.error(`✗ HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }

  const body = result.body;
  console.log(`✓ HTTP ${result.status}`);
  console.log(`  action:  ${body.action}`);
  console.log(`  message: ${body.message}`);

  switch (body.action) {
    case 'role_updated':
      console.log(`  ${TARGET_EMAIL} promoted from "${body.previous_role}" to "${body.role}".`);
      break;
    case 'membership_created':
      console.log(`  ${TARGET_EMAIL} added to org as "${body.role}".`);
      break;
    case 'invited':
      console.log(`  Invitation sent. Invited as "${body.invited_role}"; will need explicit promote to "${body.requested_role}" after accept.`);
      if (body.invitation?.accept_invitation_url) {
        console.log(`  Accept URL: ${body.invitation.accept_invitation_url}`);
      }
      break;
    case 'no_change':
      console.log(`  ${TARGET_EMAIL} is already a ${body.role}. Nothing to do.`);
      break;
    default:
      console.log(`  unexpected action — full response:`);
      console.log(JSON.stringify(body, null, 2));
  }

  console.log('');
  console.log('Now mark escalation #285 resolved with a note pointing at this run.');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
