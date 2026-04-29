/**
 * Backfill stale `type` values in `member_profiles.agents` JSONB rows.
 *
 * For each member profile, calls `resolveAgentTypes` on its `agents[]` array
 * and writes back rows where the snapshot-derived type disagrees with the
 * stored value. Idempotent — safe to re-run; converges to snapshot truth.
 *
 * Background: PR #3498 added `resolveAgentTypes()` server-side, but it only
 * runs on writes (POST/PUT). Rows saved before the fix never get re-evaluated.
 * Plus the snapshot is now the source of truth — see #3538 Problem 1.
 *
 * Usage:
 *   npx tsx server/scripts/backfill-member-agent-types.ts --dry-run
 *   npx tsx server/scripts/backfill-member-agent-types.ts
 *
 * Prerequisites: DATABASE_URL set.
 */

import { MemberDatabase } from '../src/db/member-db.js';
import { resolveAgentTypes } from '../src/routes/member-profiles.js';
import type { AgentConfig } from '../src/types.js';

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const memberDb = new MemberDatabase();
  const profiles = await memberDb.listProfiles({});

  let scanned = 0;
  let profilesUpdated = 0;
  let agentsFlipped = 0;
  const flips: Array<{ profile: string; url: string; from: string; to: string }> = [];

  for (const profile of profiles) {
    scanned++;
    if (!profile.agents || profile.agents.length === 0) continue;

    const before: AgentConfig[] = profile.agents;
    const resolved = (await resolveAgentTypes(before)) as AgentConfig[];

    const diffs: Array<{ url: string; from: string; to: string }> = [];
    for (let i = 0; i < before.length; i++) {
      const fromType = before[i].type ?? 'unknown';
      const toType = resolved[i].type ?? 'unknown';
      if (fromType !== toType) {
        diffs.push({ url: before[i].url, from: String(fromType), to: String(toType) });
      }
    }

    if (diffs.length === 0) continue;

    const profileLabel = profile.slug || profile.id;
    for (const d of diffs) {
      flips.push({ profile: profileLabel, ...d });
      console.log(`  ${profileLabel}  ${d.url}  ${d.from} -> ${d.to}`);
    }

    profilesUpdated++;
    agentsFlipped += diffs.length;

    if (!dryRun) {
      await memberDb.updateProfile(profile.id, { agents: resolved });
    }
  }

  console.log('');
  console.log(`Profiles scanned:           ${scanned}`);
  console.log(`Profiles with type changes: ${profilesUpdated}`);
  console.log(`Agent rows flipped:         ${agentsFlipped}`);
  console.log(`Mode:                       ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

  if (dryRun && agentsFlipped > 0) {
    console.log('');
    console.log('Re-run without --dry-run to persist changes.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
