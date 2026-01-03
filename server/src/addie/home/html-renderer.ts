/**
 * HTML Renderer for Addie Home
 *
 * Converts HomeContent to HTML for web display.
 * Uses CSS classes that work with design-system.css
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

/**
 * Render HomeContent as HTML string
 */
export function renderHomeHTML(content: HomeContent): string {
  const sections: string[] = [];

  // Greeting
  sections.push(renderGreeting(content.greeting));

  // Alerts
  if (content.alerts.length > 0) {
    sections.push(renderAlerts(content.alerts));
  }

  // Quick Actions
  sections.push(renderQuickActions(content.quickActions));

  // Activity Feed
  if (content.activity.length > 0) {
    sections.push(renderActivityFeed(content.activity));
  }

  // Stats
  if (content.stats) {
    const statsHtml = renderStats(content.stats);
    if (statsHtml) {
      sections.push(statsHtml);
    }
  }

  // Admin Panel
  if (content.adminPanel) {
    sections.push(renderAdminPanel(content.adminPanel));
  }

  // Footer
  sections.push(renderFooter(content.lastUpdated));

  return `<div class="addie-home">${sections.join('')}</div>`;
}

function renderGreeting(greeting: GreetingSection): string {
  let statusText: string;
  let statusClass: string;

  if (greeting.isMember) {
    statusText = greeting.orgName ? `Member at ${escapeHtml(greeting.orgName)}` : 'Member';
    statusClass = 'status-member';
  } else if (greeting.isLinked) {
    statusText = greeting.orgName ? escapeHtml(greeting.orgName) : 'Visitor';
    statusClass = 'status-linked';
  } else {
    statusText = 'Guest';
    statusClass = 'status-guest';
  }

  return `
    <div class="addie-home-greeting">
      <h2>Welcome back, ${escapeHtml(greeting.userName)}!</h2>
      <span class="addie-home-status ${statusClass}">${statusText}</span>
    </div>
  `;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function renderAlerts(alerts: AlertSection[]): string {
  const alertsHtml = alerts.map(alert => {
    const severityClass = `alert-${alert.severity}`;
    const icon = getSeverityIcon(alert.severity);

    let actionHtml = '';
    if (alert.actionLabel) {
      if (alert.actionUrl && isSafeUrl(alert.actionUrl)) {
        actionHtml = `<a href="${escapeHtml(alert.actionUrl)}" class="addie-home-alert-action" target="_blank">${escapeHtml(alert.actionLabel)}</a>`;
      } else if (alert.actionId) {
        actionHtml = `<button class="addie-home-alert-action" data-action="${escapeHtml(alert.actionId)}">${escapeHtml(alert.actionLabel)}</button>`;
      }
    }

    return `
      <div class="addie-home-alert ${severityClass}">
        <span class="addie-home-alert-icon">${icon}</span>
        <div class="addie-home-alert-content">
          <strong>${escapeHtml(alert.title)}</strong>
          <p>${escapeHtml(alert.message)}</p>
        </div>
        ${actionHtml}
      </div>
    `;
  }).join('');

  return `<div class="addie-home-alerts">${alertsHtml}</div>`;
}

function renderQuickActions(actions: QuickAction[]): string {
  const buttonsHtml = actions.map(action => {
    const styleClass = action.style === 'primary' ? 'btn-primary' : 'btn-secondary';
    return `<button class="addie-home-action ${styleClass}" data-action="${escapeHtml(action.actionId)}">${escapeHtml(action.label)}</button>`;
  }).join('');

  return `
    <div class="addie-home-section">
      <h3>Quick Actions</h3>
      <div class="addie-home-actions">${buttonsHtml}</div>
    </div>
  `;
}

function renderActivityFeed(activity: ActivityItem[]): string {
  const itemsHtml = activity.map(item => {
    const icon = item.type === 'event' ? '📅' : '👥';
    const titleHtml = item.url && isSafeUrl(item.url)
      ? `<a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);

    return `
      <div class="addie-home-activity-item">
        <span class="addie-home-activity-icon">${icon}</span>
        <div class="addie-home-activity-content">
          <strong>${titleHtml}</strong>
          <p>${escapeHtml(item.description)}</p>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="addie-home-section">
      <h3>Upcoming</h3>
      <div class="addie-home-activity">${itemsHtml}</div>
    </div>
  `;
}

function renderStats(stats: UserStats): string | null {
  const statItems: string[] = [];

  if (stats.workingGroupCount > 0) {
    statItems.push(`<div class="addie-home-stat"><span class="stat-value">${stats.workingGroupCount}</span><span class="stat-label">Working Groups</span></div>`);
  }

  // Prefer conversationActivity (Slack + web chat) over slackActivity (Slack only)
  // Only show if there's actual activity
  const activity = stats.conversationActivity || stats.slackActivity;
  if (activity && (activity.messages30d > 0 || activity.activeDays30d > 0)) {
    statItems.push(`<div class="addie-home-stat"><span class="stat-value">${activity.messages30d}</span><span class="stat-label">Messages (30d)</span></div>`);
    statItems.push(`<div class="addie-home-stat"><span class="stat-value">${activity.activeDays30d}</span><span class="stat-label">Active Days</span></div>`);
  }

  if (stats.subscriptionStatus) {
    const statusDisplay = stats.subscriptionStatus === 'active' ? '✓ Active' : stats.subscriptionStatus;
    statItems.push(`<div class="addie-home-stat"><span class="stat-value">${escapeHtml(statusDisplay)}</span><span class="stat-label">Membership</span></div>`);
  }

  if (statItems.length === 0) {
    return null;
  }

  return `
    <div class="addie-home-section">
      <h3>Your Stats</h3>
      <div class="addie-home-stats">${statItems.join('')}</div>
    </div>
  `;
}

function renderAdminPanel(panel: AdminPanel): string {
  const flaggedText = panel.flaggedThreadCount > 0
    ? `⚠️ <strong>${panel.flaggedThreadCount}</strong> flagged conversation${panel.flaggedThreadCount !== 1 ? 's' : ''} (30d)`
    : '✓ No flagged conversations';

  let goalsHtml = '';
  if (panel.insightGoals.length > 0) {
    const goalItems = panel.insightGoals.map(goal => {
      const progress = goal.target
        ? `${goal.current}/${goal.target}`
        : `${goal.current} responses`;
      const percentage = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;

      return `
        <div class="addie-home-goal">
          <div class="addie-home-goal-header">
            <span>${escapeHtml(goal.goalName)}</span>
            <span>${progress}</span>
          </div>
          ${goal.target ? `<div class="addie-home-goal-bar"><div class="addie-home-goal-progress" style="width: ${percentage}%"></div></div>` : ''}
        </div>
      `;
    }).join('');

    goalsHtml = `
      <div class="addie-home-goals">
        <h4>Insight Goals</h4>
        ${goalItems}
      </div>
    `;
  }

  return `
    <div class="addie-home-section addie-home-admin">
      <h3>Admin Panel</h3>
      <div class="addie-home-flagged">
        <p>${flaggedText}</p>
        ${panel.flaggedThreadCount > 0 ? '<a href="/admin/addie" class="addie-home-view-flagged">View</a>' : ''}
      </div>
      ${goalsHtml}
    </div>
  `;
}

function renderFooter(lastUpdated: Date): string {
  const timeString = lastUpdated.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  return `
    <div class="addie-home-footer">
      <span>Last updated at ${timeString}</span>
      <a href="/dashboard">Open Dashboard</a>
    </div>
  `;
}

function getSeverityIcon(severity: 'urgent' | 'warning' | 'info'): string {
  switch (severity) {
    case 'urgent':
      return '🚨';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * CSS styles for Addie Home components
 * Include this in your page or add to design-system.css
 */
export const ADDIE_HOME_CSS = `
/* Addie Home Component Styles */
.addie-home {
  max-width: 600px;
  margin: 0 auto;
}

.addie-home-greeting {
  text-align: center;
  padding: var(--space-6) 0;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: var(--space-6);
}

.addie-home-greeting h2 {
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--color-text-heading);
  margin-bottom: var(--space-2);
}

.addie-home-status {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.addie-home-status.status-member {
  color: var(--color-success-600);
}

.addie-home-section {
  margin-bottom: var(--space-6);
}

.addie-home-section h3 {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text-heading);
  margin-bottom: var(--space-4);
}

/* Alerts */
.addie-home-alerts {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}

.addie-home-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
}

.addie-home-alert.alert-urgent {
  border-color: var(--color-error-300);
  background: var(--color-error-50);
}

.addie-home-alert.alert-warning {
  border-color: var(--color-warning-300);
  background: var(--color-warning-50);
}

.addie-home-alert.alert-info {
  border-color: var(--color-info-300);
  background: var(--color-info-50);
}

.addie-home-alert-content {
  flex: 1;
}

.addie-home-alert-content strong {
  display: block;
  margin-bottom: var(--space-1);
}

.addie-home-alert-content p {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0;
}

.addie-home-alert-action {
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  cursor: pointer;
  text-decoration: none;
  color: var(--color-text);
  white-space: nowrap;
}

.addie-home-alert-action:hover {
  background: var(--color-bg-subtle);
}

/* Quick Actions */
.addie-home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.addie-home-action {
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.addie-home-action.btn-primary {
  background: var(--color-brand);
  color: white;
}

.addie-home-action.btn-primary:hover {
  background: var(--color-primary-700);
}

.addie-home-action.btn-secondary {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  color: var(--color-text);
}

.addie-home-action.btn-secondary:hover {
  background: var(--color-bg-subtle);
}

/* Activity Feed */
.addie-home-activity {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.addie-home-activity-item {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
}

.addie-home-activity-icon {
  font-size: var(--text-lg);
}

.addie-home-activity-content strong {
  display: block;
  margin-bottom: var(--space-1);
}

.addie-home-activity-content strong a {
  color: var(--color-brand);
  text-decoration: none;
}

.addie-home-activity-content strong a:hover {
  text-decoration: underline;
}

.addie-home-activity-content p {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0;
}

/* Stats */
.addie-home-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-4);
}

.addie-home-stat {
  text-align: center;
  padding: var(--space-4);
  background: var(--color-bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
}

.addie-home-stat .stat-value {
  display: block;
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--color-text-heading);
}

.addie-home-stat .stat-label {
  display: block;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin-top: var(--space-1);
}

/* Admin Panel */
.addie-home-admin {
  background: var(--color-bg-subtle);
  padding: var(--space-5);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
}

.addie-home-flagged {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.addie-home-flagged p {
  margin: 0;
}

.addie-home-view-flagged {
  color: var(--color-brand);
  text-decoration: none;
}

.addie-home-goals h4 {
  font-size: var(--text-base);
  font-weight: 600;
  margin-bottom: var(--space-3);
}

.addie-home-goal {
  margin-bottom: var(--space-3);
}

.addie-home-goal-header {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-sm);
  margin-bottom: var(--space-1);
}

.addie-home-goal-bar {
  height: 8px;
  background: var(--color-gray-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.addie-home-goal-progress {
  height: 100%;
  background: var(--color-brand);
  border-radius: var(--radius-full);
  transition: width 0.3s;
}

/* Footer */
.addie-home-footer {
  display: flex;
  justify-content: space-between;
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.addie-home-footer a {
  color: var(--color-brand);
  text-decoration: none;
}

.addie-home-footer a:hover {
  text-decoration: underline;
}
`;
