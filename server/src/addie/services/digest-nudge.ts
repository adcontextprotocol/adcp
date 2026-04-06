/**
 * Digest Nudge Picker
 *
 * Selects the single most relevant action for a newsletter recipient
 * based on their profile, engagement, and membership status.
 * Renders near the top of the email, right after the opening take.
 */

import type { DigestEmailRecipient } from '../../db/digest-db.js';

export interface DigestNudge {
  text: string;
  ctaLabel: string;
  ctaUrl: string;
}

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

/**
 * Pick the single most important nudge for this recipient.
 * Priority order matters — first match wins.
 */
export function pickNudge(recipient: DigestEmailRecipient): DigestNudge | null {
  // 1. Not a member and should be → strongest conversion nudge
  if (!recipient.is_member && !recipient.has_slack) {
    return {
      text: 'Join 1,300+ professionals building the future of agentic advertising.',
      ctaLabel: 'Become a member',
      ctaUrl: `${BASE_URL}/join`,
    };
  }

  // 2. Member but not in Slack → get them into the community
  if (recipient.is_member && !recipient.has_slack) {
    return {
      text: 'The conversation happens in Slack — 400+ practitioners are there now.',
      ctaLabel: 'Join Slack',
      ctaUrl: `${BASE_URL}/join#slack`,
    };
  }

  // 3. Started certification but didn't finish → re-engage
  if (recipient.cert_modules_completed > 0 && recipient.cert_modules_completed < recipient.cert_total_modules) {
    const remaining = recipient.cert_total_modules - recipient.cert_modules_completed;
    return {
      text: `You're ${recipient.cert_modules_completed} module${recipient.cert_modules_completed > 1 ? 's' : ''} in — ${remaining} to go for your certification.`,
      ctaLabel: 'Continue learning',
      ctaUrl: `${BASE_URL}/academy`,
    };
  }

  // 4. In Slack but not in any working group → get them contributing
  if (recipient.has_slack && recipient.wg_count === 0) {
    return {
      text: 'Working groups are where the standards get built. Find one that matches your work.',
      ctaLabel: 'Browse working groups',
      ctaUrl: `${BASE_URL}/committees`,
    };
  }

  // 5. Contributor seat, no certification started → nudge to learn
  if (recipient.seat_type === 'contributor' && recipient.cert_modules_completed === 0) {
    return {
      text: 'Contributors who complete certification get listed in the registry.',
      ctaLabel: 'Start certification',
      ctaUrl: `${BASE_URL}/academy`,
    };
  }

  // 6. Has profile gap → complete it
  if (!recipient.has_profile && recipient.is_member) {
    return {
      text: 'Complete your profile so other members can find you.',
      ctaLabel: 'Update your profile',
      ctaUrl: `${BASE_URL}/dashboard`,
    };
  }

  // 7. Active engaged member → no nudge needed, just the content
  return null;
}
