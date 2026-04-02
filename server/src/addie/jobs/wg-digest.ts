/**
 * Working Group Digest Job (disabled)
 *
 * WG digest content is now consolidated into The Prompt weekly newsletter.
 * These stubs remain for backward compatibility with the job scheduler.
 */

import { createLogger } from '../../logger.js';

const logger = createLogger('wg-digest');

export interface WgDigestResult {
  groupsChecked: number;
  groupsSent: number;
  groupsSkipped: number;
  totalEmails: number;
}

export async function runWgDigestPrepJob(): Promise<{ groupsChecked: number; emailsSent: number }> {
  logger.info('WG digest prep disabled — content consolidated into The Prompt');
  return { groupsChecked: 0, emailsSent: 0 };
}

export async function runWgDigestJob(): Promise<WgDigestResult> {
  logger.info('WG digest disabled — content consolidated into The Prompt');
  return { groupsChecked: 0, groupsSent: 0, groupsSkipped: 0, totalEmails: 0 };
}
