import {
  isSafeNotificationPath,
  NotificationDatabase,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
} from '../db/notification-db.js';
import { SlackDatabase } from '../db/slack-db.js';
import { sendDirectMessage } from '../slack/client.js';
import { createLogger } from '../logger.js';
import { flattenToSingleLine, sanitizeSlackLine } from '../utils/slack-escape.js';

const logger = createLogger('notification-service');
const notificationDb = new NotificationDatabase();
const slackDb = new SlackDatabase();

export { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH };

/**
 * Create an in-app notification and optionally send a Slack DM.
 * Fire-and-forget safe — errors are logged but never thrown.
 *
 * `title` must be a fixed template plus platform-controlled fields. Anything
 * an agent, a member, or a remote service can influence belongs in `body`:
 * both halves are flattened and capped by `createNotification` and escaped
 * for mrkdwn here, but only `body` is sized and positioned for text we did
 * not author. See adcp#8320 — the compliance DM used to interpolate an
 * agent's own error string into its title, which let a hostile agent put
 * `<!channel>`, a forged link, or 10 KB of prose into the headline of a
 * message the owner reads as ours.
 */
export async function notifyUser(data: {
  recipientUserId: string;
  actorUserId?: string;
  type: string;
  referenceId?: string;
  referenceType?: string;
  title: string;
  body?: string;
  /** Site-relative path (must start with `/`). Rendered as a Slack link. */
  url?: string;
}): Promise<void> {
  // Recomputed rather than read back, so the DM says exactly what
  // `createNotification` stored. The cap lives at the write seam; these two
  // calls use the same function and the same constants, so they cannot
  // drift. Both halves stay unescaped here — each renderer escapes for its
  // own surface, and escaping twice would double-encode the row.
  let title = '';
  let body: string | undefined;

  try {
    title = flattenToSingleLine(data.title, NOTIFICATION_TITLE_MAX_LENGTH);
    body = data.body ? flattenToSingleLine(data.body, NOTIFICATION_BODY_MAX_LENGTH) : undefined;

    // Don't notify users about their own actions
    if (data.actorUserId && data.recipientUserId === data.actorUserId) {
      return;
    }

    await notificationDb.createNotification(data);

    // Send Slack DM if user has a linked Slack account
    const slackMapping = await slackDb.getByWorkosUserId(data.recipientUserId);
    if (slackMapping?.slack_user_id) {
      const lines = [sanitizeSlackLine(data.title, NOTIFICATION_TITLE_MAX_LENGTH)];
      if (body) lines.push(sanitizeSlackLine(data.body!, NOTIFICATION_BODY_MAX_LENGTH));

      const link = slackLinkFor(data.url);
      if (link) lines.push(link);

      await sendDirectMessage(slackMapping.slack_user_id, { text: lines.join('\n') });
    }
  } catch (error) {
    // Log the bounded fields, not `data` — an unbounded title or body is
    // exactly what an error on this path tends to be carrying.
    logger.error(
      { err: error, recipientUserId: data.recipientUserId, type: data.type, title, body },
      'Failed to send notification',
    );
  }
}

/**
 * Build the trailing `<url|View>` link. The target is the one part of the
 * message that cannot be escaped — a `>` or `|` inside it closes the link
 * early and leaves the rest as top-level mrkdwn — so the same predicate
 * that decides what gets stored decides what gets linked. Every caller
 * passes a site-relative path; anything else is a bug upstream and not
 * worth a broken DM.
 */
function slackLinkFor(url: string | undefined): string | null {
  if (!url) return null;
  if (!isSafeNotificationPath(url)) {
    logger.warn({ url }, 'Dropping notification link with an unexpected shape');
    return null;
  }
  const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';
  return `<${baseUrl}${url}|View>`;
}
