#!/usr/bin/env npx tsx
/**
 * Seed in-app notifications for a dev user.
 *
 * Nothing in local dev produces notifications organically — they come from
 * connection requests, WG joins, event reminders, and compliance jobs, none of
 * which fire on a fresh docker stack. This writes a realistic spread straight
 * into the notifications table so the bell badge, the unread-only dropdown, and
 * the /community/notifications page (unread styling, relative timestamps,
 * "Load more" pagination, mark-as-read) all have something to exercise.
 *
 * created_at is set explicitly, which NotificationDatabase.createNotification
 * does not allow — hence the direct INSERT rather than the service layer.
 *
 * Usage (run on the host against the docker Postgres; scripts/ is not compiled
 * into dist/, so this only runs under tsx):
 *   DATABASE_URL="postgresql://adcp:localdev@localhost:$(docker compose port postgres 5432 | cut -d: -f2)/adcp_registry" \
 *     ./node_modules/.bin/tsx server/scripts/seed-notifications.ts
 *
 *   --user <key>   dev user who receives them (default: admin)
 *   --clear        delete that user's existing notifications first
 */

import { initializeDatabase, closeDatabase, query } from '../src/db/client.js';

// Mirrors DEV_USERS in server/src/middleware/auth.ts. Duplicated rather than
// imported so this script doesn't pull in the WorkOS SDK or the prod-boot guard.
const DEV_USER_IDS: Record<string, string> = {
  admin: 'user_dev_admin_001',
  member: 'user_dev_member_001',
  personal: 'user_dev_personal_001',
  nonmember: 'user_dev_nonmember_001',
  leader: 'user_dev_leader_001',
  learner1: 'user_dev_learner_001',
  builder: 'user_dev_builder_001',
};

// Actor IDs join to users.workos_user_id for the avatar initials and name.
const ACTOR = {
  member: 'user_dev_member_001',
  personal: 'user_dev_personal_001',
  leader: 'user_dev_leader_001',
  learner: 'user_dev_learner_001',
  builder: 'user_dev_builder_001',
};

interface SeedNotification {
  /** Minutes ago — drives the relative-time formatting in the UI. */
  minutesAgo: number;
  type: string;
  title: string;
  url?: string;
  actor?: string;
  referenceId?: string;
  referenceType?: string;
  read?: boolean;
}

const MIN = 1;
const HOUR = 60;
const DAY = 24 * HOUR;

// Types and title shapes follow the real call sites (routes/community.ts,
// db/community-db.ts, notifications/compliance.ts, addie/jobs/job-definitions.ts,
// services/working-group-membership-service.ts), with canonical organization
// naming, so seeded rows look like production rows without carrying legacy copy.
const NOTIFICATIONS: SeedNotification[] = [
  // --- Unread, recent: what the bell dropdown shows ---
  {
    minutesAgo: 0,
    type: 'connection_request',
    title: 'Member User sent you a connection request',
    url: '/community/connections',
    actor: ACTOR.member,
    referenceType: 'connection',
  },
  {
    minutesAgo: 4 * MIN,
    type: 'wg_member_joined',
    title: 'Personal Account (Northstar Media) joined Creative Working Group. Also active in Signals Working Group',
    url: '/working-groups/creative',
    actor: ACTOR.personal,
    referenceType: 'working_group',
  },
  {
    minutesAgo: 22 * MIN,
    type: 'compliance_regression',
    title: 'Your agent Northstar Sales Agent has compliance failures. Failing tracks: media-buy (3 failing). Creative sync returned 500 on build_creative.',
    url: '/registry/agents/northstar-sales-agent',
    referenceType: 'agent',
  },
  {
    minutesAgo: 55 * MIN,
    type: 'connection_accepted',
    title: 'Committee Leader accepted your connection request',
    url: '/community/connections',
    actor: ACTOR.leader,
    referenceType: 'connection',
  },
  {
    minutesAgo: 2 * HOUR,
    type: 'badge_earned',
    title: 'You earned the "Connector" badge',
    url: '/community',
    referenceId: 'connector',
    referenceType: 'badge',
  },
  {
    minutesAgo: 3 * HOUR,
    type: 'event_reminder',
    title: 'Reminder: AdCP Community Call is tomorrow',
    url: '/events/adcp-community-call',
    referenceType: 'event',
  },
  {
    minutesAgo: 5 * HOUR,
    type: 'meeting_scheduled',
    title: 'Meeting scheduled: Creative WG — format taxonomy review',
    url: '/meetings/8f3c1d20-1111-4b0a-9a3e-2c7d5e6f7a01',
    actor: ACTOR.leader,
    referenceId: '8f3c1d20-1111-4b0a-9a3e-2c7d5e6f7a01',
    referenceType: 'meeting',
  },
  {
    minutesAgo: 9 * HOUR,
    type: 'verification_earned',
    title: 'Your agent Northstar Sales Agent is now an AgenticAdvertising.org Verified sales agent (v1.7.0).',
    url: '/registry/agents/northstar-sales-agent',
    referenceType: 'agent',
  },
  {
    minutesAgo: 14 * HOUR,
    type: 'waitlist_promoted',
    title: "You're in! Your registration for Agentic Advertising Summit has been confirmed",
    url: '/events/agentic-advertising-summit',
    referenceType: 'event',
  },
  {
    minutesAgo: 20 * HOUR,
    type: 'connection_request',
    title: 'Builder Member sent you a connection request',
    url: '/community/connections',
    actor: ACTOR.builder,
    referenceType: 'connection',
  },
  // A notification with no url — renders as a non-clickable div, not an anchor.
  {
    minutesAgo: 26 * HOUR,
    type: 'system_notice',
    title: 'Scheduled maintenance on the registry API this Saturday, 02:00–03:00 UTC',
    referenceType: 'system',
  },

  // --- Read: exercises the non-highlighted row style ---
  {
    minutesAgo: 30 * HOUR,
    type: 'wg_welcome',
    title: 'Welcome to Signals Working Group!',
    url: '/working-groups/signals',
    referenceType: 'working_group',
    read: true,
  },
  {
    minutesAgo: 2 * DAY,
    type: 'compliance_recovery',
    title: 'Your agent Northstar Sales Agent is passing all compliance tracks again.',
    url: '/registry/agents/northstar-sales-agent',
    referenceType: 'agent',
    read: true,
  },
  {
    minutesAgo: 2 * DAY + 5 * HOUR,
    type: 'event_updated',
    title: 'AdCP Community Call has been updated',
    url: '/events/adcp-community-call',
    referenceType: 'event',
    read: true,
  },
  {
    minutesAgo: 3 * DAY,
    type: 'connection_accepted',
    title: 'Learner One accepted your connection request',
    url: '/community/connections',
    actor: ACTOR.learner,
    referenceType: 'connection',
    read: true,
  },
  {
    minutesAgo: 3 * DAY + 8 * HOUR,
    type: 'badge_earned',
    title: 'You earned the "Profile complete" badge',
    url: '/community',
    referenceId: 'profile_complete',
    referenceType: 'badge',
    read: true,
  },
  {
    minutesAgo: 4 * DAY,
    type: 'certification_nudge',
    title: 'Your team is working toward certification — pick up where you left off',
    url: '/certification',
    referenceType: 'certification',
    read: true,
  },
  {
    minutesAgo: 4 * DAY + 6 * HOUR,
    type: 'verification_lost',
    title: 'Your agent Harbor Signals Agent lost its AgenticAdvertising.org Verified signals badge (v0.9.2). Two required tracks regressed.',
    url: '/registry/agents/harbor-signals-agent',
    referenceType: 'agent',
    read: true,
  },
  {
    minutesAgo: 5 * DAY,
    type: 'event_follow_up',
    title: 'Thanks for joining AdCP Community Call — the recording and notes are up',
    url: '/events/adcp-community-call',
    referenceType: 'event',
    read: true,
  },
  {
    minutesAgo: 6 * DAY,
    type: 'wg_member_joined',
    title: 'Learner One joined Creative Working Group',
    url: '/working-groups/creative',
    actor: ACTOR.learner,
    referenceType: 'working_group',
    read: true,
  },

  // --- Older than a week: relative time switches to an absolute date ---
  {
    minutesAgo: 8 * DAY,
    type: 'compliance_extended_outage',
    title: 'Your agent Harbor Signals Agent has been failing for 6 days. Buyers are seeing failures.',
    url: '/registry?tab=agents',
    referenceType: 'agent',
    read: true,
  },
  {
    minutesAgo: 11 * DAY,
    type: 'badge_earned',
    title: 'You earned the "Working group member" badge',
    url: '/community',
    referenceId: 'working_group_member',
    referenceType: 'badge',
    read: true,
  },
  {
    minutesAgo: 14 * DAY,
    type: 'connection_accepted',
    title: 'Member User accepted your connection request',
    url: '/community/connections',
    actor: ACTOR.member,
    referenceType: 'connection',
    read: true,
  },
  {
    minutesAgo: 18 * DAY,
    type: 'meeting_scheduled',
    title: 'Meeting scheduled: Signals WG — audience taxonomy kickoff',
    url: '/meetings/8f3c1d20-2222-4b0a-9a3e-2c7d5e6f7a02',
    actor: ACTOR.leader,
    referenceId: '8f3c1d20-2222-4b0a-9a3e-2c7d5e6f7a02',
    referenceType: 'meeting',
    read: true,
  },
  {
    minutesAgo: 24 * DAY,
    type: 'wg_welcome',
    title: 'Welcome to Creative Working Group!',
    url: '/working-groups/creative',
    referenceType: 'working_group',
    read: true,
  },
  {
    minutesAgo: 31 * DAY,
    type: 'badge_earned',
    title: 'You earned the "Contributor" badge',
    url: '/community',
    referenceId: 'contributor',
    referenceType: 'badge',
    read: true,
  },
];

function parseArgs(): { userKey: string; clear: boolean } {
  const args = process.argv.slice(2);
  let userKey = 'admin';
  let clear = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') {
      userKey = args[++i];
    } else if (args[i] === '--clear') {
      clear = true;
    } else {
      console.error(`Unknown argument "${args[i]}"`);
      process.exit(1);
    }
  }

  return { userKey, clear };
}

async function main(): Promise<void> {
  const { userKey, clear } = parseArgs();

  const recipientId = DEV_USER_IDS[userKey];
  if (!recipientId) {
    console.error(`Unknown dev user "${userKey}". Options: ${Object.keys(DEV_USER_IDS).join(', ')}`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    console.error('Local docker stack: DATABASE_URL=postgresql://adcp:localdev@localhost:$(docker compose port postgres 5432 | cut -d: -f2)/adcp_registry');
    process.exit(1);
  }

  initializeDatabase({ connectionString, ssl: false, maxPoolSize: 2 });

  if (clear) {
    const deleted = await query('DELETE FROM notifications WHERE recipient_user_id = $1', [recipientId]);
    console.log(`Cleared ${deleted.rowCount ?? 0} existing notification(s) for ${recipientId}`);
  }

  for (const n of NOTIFICATIONS) {
    await query(
      `INSERT INTO notifications
         (recipient_user_id, actor_user_id, type, reference_id, reference_type, title, url, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - ($9 || ' minutes')::interval)`,
      [
        recipientId,
        n.actor ?? null,
        n.type,
        n.referenceId ?? null,
        n.referenceType ?? null,
        n.title,
        n.url ?? null,
        n.read ?? false,
        String(n.minutesAgo),
      ]
    );
  }

  const unread = NOTIFICATIONS.filter((n) => !n.read).length;
  await closeDatabase();

  console.log(`Seeded ${NOTIFICATIONS.length} notifications`);
  console.log(`  recipient: ${recipientId} (dev user "${userKey}")`);
  console.log(`  unread:    ${unread} (bell badge count)`);
  console.log(`  read:      ${NOTIFICATIONS.length - unread}`);
  console.log('');
  console.log('To view them:');
  console.log(`  1. Sign in at http://localhost:3000/dev-login.html as the "${userKey}" dev user`);
  console.log('  2. Click the bell in the navbar — the dropdown lists the 10 newest unread');
  console.log('  3. Open http://localhost:3000/community/notifications for the full list');
  console.log('');
  console.log('Note: unread counts are cached in-process for 30s, so the badge may lag');
  console.log('a re-run by up to half a minute.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
