/**
 * Slack Block Kit Renderer
 *
 * Converts HomeContent to Slack App Home view.
 */

import type {
  HomeContent,
  AlertSection,
  QuickAction,
  ActivityItem,
  UserStats,
  AdminPanel,
  GreetingSection,
} from './types.js';

// Slack Block Kit types - using inline definitions for simplicity
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SlackBlock = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SlackView = any;

/**
 * Render HomeContent as Slack App Home view
 */
export function renderHomeView(content: HomeContent): SlackView {
  const blocks: SlackBlock[] = [];

  // Header with greeting
  blocks.push(renderGreeting(content.greeting));
  blocks.push({ type: 'divider' });

  // Alerts (if any)
  if (content.alerts.length > 0) {
    blocks.push(...renderAlerts(content.alerts));
    blocks.push({ type: 'divider' });
  }

  // Quick Actions
  blocks.push(...renderQuickActions(content.quickActions));
  blocks.push({ type: 'divider' });

  // Activity Feed
  if (content.activity.length > 0) {
    blocks.push(...renderActivityFeed(content.activity));
    blocks.push({ type: 'divider' });
  }

  // Stats
  if (content.stats) {
    blocks.push(...renderStats(content.stats));
    blocks.push({ type: 'divider' });
  }

  // Admin Panel (if admin)
  if (content.adminPanel) {
    blocks.push(...renderAdminPanel(content.adminPanel));
    blocks.push({ type: 'divider' });
  }

  // Footer
  blocks.push(renderFooter(content.lastUpdated));

  return {
    type: 'home',
    blocks,
  };
}

/**
 * Render error state view
 */
export function renderErrorView(message: string): SlackView {
  return {
    type: 'home',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Something went wrong*\n${message}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Refresh', emoji: true },
            action_id: 'addie_home_refresh',
          },
        ],
      },
    ],
  };
}

function renderGreeting(greeting: GreetingSection): SlackBlock {
  let statusText: string;
  if (greeting.isMember) {
    statusText = greeting.orgName ? `Member at ${greeting.orgName}` : 'Member';
  } else if (greeting.isLinked) {
    statusText = greeting.orgName ? `${greeting.orgName}` : 'Visitor';
  } else {
    statusText = 'Guest';
  }

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:wave: *Welcome back, ${greeting.userName}!*\n${statusText}`,
    },
  };
}

function renderAlerts(alerts: AlertSection[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  for (const alert of alerts) {
    const icon = getSeverityIcon(alert.severity);

    const section: SlackBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${alert.title}*\n${alert.message}`,
      },
    };

    // Add action button if available
    if (alert.actionLabel) {
      const button: SlackBlock = {
        type: 'button',
        text: { type: 'plain_text', text: alert.actionLabel, emoji: true },
      };

      if (alert.actionUrl) {
        button.url = alert.actionUrl;
      } else if (alert.actionId) {
        button.action_id = alert.actionId;
      }

      section.accessory = button;
    }

    blocks.push(section);
  }

  return blocks;
}

function renderQuickActions(actions: QuickAction[]): SlackBlock[] {
  const header: SlackBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Quick Actions*',
    },
  };

  const buttons = actions.slice(0, 5).map((action) => ({
    type: 'button',
    text: { type: 'plain_text', text: action.label, emoji: true },
    action_id: action.actionId,
    ...(action.style === 'primary' ? { style: 'primary' } : {}),
  }));

  const actionsBlock: SlackBlock = {
    type: 'actions',
    elements: buttons,
  };

  return [header, actionsBlock];
}

function renderActivityFeed(activity: ActivityItem[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const header: SlackBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Upcoming*',
    },
  };
  blocks.push(header);

  for (const item of activity.slice(0, 5)) {
    const icon = item.type === 'event' ? ':calendar:' : ':busts_in_silhouette:';
    const titleText = item.url ? `<${item.url}|${item.title}>` : item.title;

    const context: SlackBlock = {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${icon} *${titleText}*\n${item.description}`,
        },
      ],
    };
    blocks.push(context);
  }

  return blocks;
}

function renderStats(stats: UserStats): SlackBlock[] {
  const fields: string[] = [];

  if (stats.workingGroupCount > 0) {
    fields.push(`*Working Groups*\n${stats.workingGroupCount}`);
  }

  if (stats.slackActivity) {
    fields.push(`*Messages (30d)*\n${stats.slackActivity.messages30d}`);
    fields.push(`*Active Days*\n${stats.slackActivity.activeDays30d}`);
  }

  if (stats.subscriptionStatus) {
    const statusDisplay = stats.subscriptionStatus === 'active' ? ':white_check_mark: Active' : stats.subscriptionStatus;
    fields.push(`*Membership*\n${statusDisplay}`);
  }

  if (fields.length === 0) {
    return [];
  }

  const header: SlackBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Your Stats*',
    },
  };

  const statsSection: SlackBlock = {
    type: 'section',
    fields: fields.map((text) => ({
      type: 'mrkdwn',
      text,
    })),
  };

  return [header, statsSection];
}

function renderAdminPanel(panel: AdminPanel): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const header: SlackBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: 'Admin Panel',
      emoji: true,
    },
  };
  blocks.push(header);

  // Flagged threads
  const flaggedText = panel.flaggedThreadCount > 0
    ? `:warning: *${panel.flaggedThreadCount}* flagged conversation${panel.flaggedThreadCount !== 1 ? 's' : ''} (30d)`
    : ':white_check_mark: No flagged conversations';

  const flaggedSection: SlackBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: flaggedText,
    },
  };

  if (panel.flaggedThreadCount > 0) {
    flaggedSection.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: 'View', emoji: true },
      action_id: 'addie_home_view_flagged',
    };
  }

  blocks.push(flaggedSection);

  // Prospect stats (if available)
  if (panel.prospectStats) {
    const { hotCount, needsFollowupCount, totalOwned } = panel.prospectStats;
    const prospectParts: string[] = [];

    if (hotCount > 0) {
      prospectParts.push(`:fire: ${hotCount} hot`);
    }
    if (needsFollowupCount > 0) {
      prospectParts.push(`:clock3: ${needsFollowupCount} need follow-up`);
    }
    prospectParts.push(`:bust_in_silhouette: ${totalOwned} total`);

    const prospectSection: SlackBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*My Prospects*\n${prospectParts.join(' | ')}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View All', emoji: true },
        url: 'https://agenticadvertising.org/admin/prospects?mine=true',
        action_id: 'addie_home_view_prospects',
      },
    };
    blocks.push(prospectSection);
  }

  // Insight goals
  if (panel.insightGoals.length > 0) {
    const goalsHeader: SlackBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Insight Goals*',
      },
    };
    blocks.push(goalsHeader);

    for (const goal of panel.insightGoals) {
      const progress = goal.target
        ? `${goal.current}/${goal.target}`
        : `${goal.current} responses`;
      const progressBar = goal.target ? renderProgressBar(goal.current, goal.target) : '';

      const goalContext: SlackBlock = {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${goal.goalName}: ${progress} ${progressBar}`,
          },
        ],
      };
      blocks.push(goalContext);
    }
  }

  return blocks;
}

function renderFooter(lastUpdated: Date): SlackBlock {
  const timeString = lastUpdated.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Last updated at ${timeString}`,
      },
      {
        type: 'mrkdwn',
        text: '<https://agenticadvertising.org/dashboard|Open Dashboard>',
      },
    ],
  };
}

function getSeverityIcon(severity: 'urgent' | 'warning' | 'info'): string {
  switch (severity) {
    case 'urgent':
      return ':rotating_light:';
    case 'warning':
      return ':warning:';
    case 'info':
      return ':information_source:';
  }
}

function renderProgressBar(current: number, target: number): string {
  const percentage = Math.min(100, Math.round((current / target) * 100));
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
