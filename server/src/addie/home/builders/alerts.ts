/**
 * Alerts Builder
 *
 * Builds alert sections from member context and billing data.
 */

import type { AlertSection } from '../types.js';
import type { MemberContext } from '../../member-context.js';
import { getPendingInvoicesByEmail } from '../../../billing/stripe-client.js';
import { createLogger } from '../../../logger.js';
import { describeEscalationSla, listEscalationsForUser } from '../../../db/escalation-db.js';

const logger = createLogger('addie-home-builder-alerts');

/**
 * Build alerts requiring user attention
 */
export async function buildAlerts(memberContext: MemberContext): Promise<AlertSection[]> {
  const alerts: AlertSection[] = [];
  const workosUserId = memberContext.workos_user?.workos_user_id;
  const slackUserId = memberContext.slack_user?.slack_user_id;

  if (workosUserId || slackUserId) {
    try {
      const escalations = await listEscalationsForUser(workosUserId, slackUserId);
      const active = escalations.filter(e => (
        e.status === 'open' || e.status === 'acknowledged' || e.status === 'in_progress'
      ));

      if (active.length > 0) {
        const followUp = active.find(e => describeEscalationSla(e).needs_follow_up);
        const newest = active[0];
        const current = followUp || newest;
        const statusLabel = current.status === 'open'
          ? 'waiting for team pickup'
          : current.status === 'acknowledged'
            ? 'seen by the team'
            : 'being worked on';

        alerts.push({
          id: 'open-escalation',
          severity: followUp ? 'urgent' : 'warning',
          title: active.length === 1 ? 'Support request open' : `${active.length} support requests open`,
          message: `"${current.summary}" is ${statusLabel}. You can add details or close it from your dashboard.`,
          actionLabel: 'View request',
          actionUrl: 'https://agenticadvertising.org/dashboard#escalations',
        });
      }
    } catch (error) {
      logger.warn({ error, workosUserId, slackUserId }, 'Failed to fetch escalations for home alerts');
    }
  }

  // 1. Account not linked (important for guests)
  if (!memberContext.slack_linked) {
    alerts.push({
      id: 'link-account',
      severity: 'info',
      title: 'Link Your Account',
      message: 'Connect your Slack to AgenticAdvertising.org for a personalized experience',
      actionLabel: 'Link Account',
      actionUrl: 'https://agenticadvertising.org/dashboard',
    });
  }

  // 2. Pending invoices (only for linked users with email)
  if (memberContext.workos_user?.email) {
    try {
      const pendingInvoices = await getPendingInvoicesByEmail(memberContext.workos_user.email);
      if (pendingInvoices.length > 0) {
        const totalDue = pendingInvoices.reduce((sum, inv) => sum + inv.amount_due, 0);
        const formattedAmount = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: pendingInvoices[0].currency.toUpperCase(),
        }).format(totalDue / 100);

        alerts.push({
          id: 'pending-invoice',
          severity: 'warning',
          title: 'Invoice Due',
          message: `You have ${pendingInvoices.length} pending invoice${pendingInvoices.length > 1 ? 's' : ''} totaling ${formattedAmount}`,
          actionLabel: 'Pay Now',
          actionUrl: pendingInvoices[0].hosted_invoice_url ?? undefined,
        });
      }
    } catch (error) {
      logger.warn({ error, email: memberContext.workos_user.email }, 'Failed to fetch pending invoices for home alerts');
    }
  }

  // 3. Incomplete profile - missing tagline (members only)
  if (memberContext.is_member && !memberContext.member_profile?.tagline) {
    alerts.push({
      id: 'incomplete-profile',
      severity: 'info',
      title: 'Complete Your Profile',
      message: 'Add a company description to help others learn about you',
      actionLabel: 'Update Profile',
      actionId: 'addie_home_update_profile',
    });
  }

  // 4. Missing logo (members only)
  if (memberContext.is_member && !memberContext.member_profile?.logo_url) {
    alerts.push({
      id: 'missing-logo',
      severity: 'info',
      title: 'Add Your Company Logo',
      message: 'Upload a logo to appear on the member directory and homepage',
      actionLabel: 'Add Logo',
      actionUrl: 'https://agenticadvertising.org/member-profile',
    });
  }

  // 5. Pending join requests (admins only)
  if (memberContext.pending_join_requests_count && memberContext.pending_join_requests_count > 0) {
    const count = memberContext.pending_join_requests_count;
    alerts.push({
      id: 'pending-join-requests',
      severity: 'warning',
      title: `${count} Pending Join Request${count > 1 ? 's' : ''}`,
      message: `${count} ${count > 1 ? 'people are' : 'person is'} waiting to join your team`,
      actionLabel: 'Review Requests',
      actionUrl: 'https://agenticadvertising.org/dashboard#team',
    });
  }

  // 6. Upcoming renewal (within 30 days)
  if (memberContext.subscription?.current_period_end) {
    const daysUntilRenewal = Math.floor(
      (memberContext.subscription.current_period_end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntilRenewal <= 30 && daysUntilRenewal > 0) {
      const isCanceling = memberContext.subscription.cancel_at_period_end;
      alerts.push({
        id: 'upcoming-renewal',
        severity: isCanceling ? 'warning' : 'info',
        title: isCanceling ? 'Membership Ending' : 'Membership Renewal',
        message: isCanceling
          ? `Your membership ends in ${daysUntilRenewal} days`
          : `Your membership renews in ${daysUntilRenewal} days`,
        actionLabel: 'Manage Membership',
        actionUrl: 'https://agenticadvertising.org/dashboard/membership',
      });
    }
  }

  return alerts;
}
