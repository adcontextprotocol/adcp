/**
 * Quick Actions Builder
 *
 * Builds context-aware quick action buttons.
 * Actions route through Addie conversations where appropriate.
 */

import type { QuickAction } from '../types.js';
import type { MemberContext } from '../../member-context.js';

/**
 * Build quick actions based on user context
 */
export function buildQuickActions(
  memberContext: MemberContext,
  isAAOAdmin: boolean
): QuickAction[] {
  const actions: QuickAction[] = [];

  // Primary CTA: Ask Addie
  actions.push({
    id: 'ask-addie',
    label: 'Ask Addie',
    description: 'Start a conversation',
    actionId: 'addie_home_ask_addie',
    style: 'primary',
  });

  // Update Profile (for members)
  if (memberContext.is_member) {
    actions.push({
      id: 'update-profile',
      label: 'Update Profile',
      description: 'Edit your member profile',
      actionId: 'addie_home_update_profile',
    });
  }

  // Browse Working Groups
  actions.push({
    id: 'browse-groups',
    label: 'Working Groups',
    description: 'Find groups to join',
    actionId: 'addie_home_browse_groups',
  });

  // Admin: View Flagged Threads
  if (isAAOAdmin) {
    actions.push({
      id: 'view-flagged',
      label: 'Flagged Threads',
      description: 'Review flagged conversations',
      actionId: 'addie_home_view_flagged',
    });
  }

  return actions;
}
