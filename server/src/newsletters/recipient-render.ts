/**
 * Render a newsletter edition for one recipient.
 *
 * The send pipeline and the admin test send both go through this, so a test
 * send shows the same personalised parts (greeting, working-group expansion,
 * persona copy, nudge, segment CTA) the recipient gets in the real send.
 */

import { getPersonaCluster } from '../db/digest-db.js';
import type { NewsletterConfig, NewsletterRecipient } from './config.js';

export interface RecipientRenderInput {
  content: unknown;
  editionDate: string;
  trackingId: string;
  recipient: NewsletterRecipient;
  userWorkingGroups?: string[];
  /** Send date printed in the header (YYYY-MM-DD). */
  displayDate?: string;
}

export function recipientSegment(recipient: Pick<NewsletterRecipient, 'has_slack'>): 'both' | 'website_only' {
  return recipient.has_slack ? 'both' : 'website_only';
}

export function renderEditionForRecipient(
  config: NewsletterConfig,
  input: RecipientRenderInput,
): { html: string; text: string; segment: 'both' | 'website_only' } {
  const segment = recipientSegment(input.recipient);
  const cluster = getPersonaCluster(input.recipient.persona);
  const { html, text } = config.renderEmail(
    input.content,
    input.trackingId,
    input.editionDate,
    segment,
    input.recipient.first_name || undefined,
    input.userWorkingGroups,
    cluster,
    input.recipient,
    { displayDate: input.displayDate },
  );
  return { html, text, segment };
}
