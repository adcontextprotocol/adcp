/**
 * HTML Renderer for Addie Home
 *
 * Chat-first welcome screen. Suggested prompts are the hero element.
 * Alerts show when relevant. Everything else lives in the sidebar/dashboard.
 */

import type {
  HomeContent,
  AlertSection,
  SuggestedPrompt,
  GreetingSection,
} from './types.js';

/**
 * Render HomeContent as HTML string
 */
export function renderHomeHTML(content: HomeContent): string {
  const sections: string[] = [];

  // Greeting — minimal, just sets context
  sections.push(renderGreeting(content.greeting));

  // Alerts — only actionable items (warnings/urgent), not onboarding nudges
  const actionableAlerts = content.alerts.filter(a => a.severity !== 'info');
  if (actionableAlerts.length > 0) {
    sections.push(renderAlerts(actionableAlerts));
  }

  // Suggested prompts — the main event
  if (content.suggestedPrompts && content.suggestedPrompts.length > 0) {
    sections.push(renderSuggestedPrompts(content.suggestedPrompts));
  }

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
      <h2>Hi, ${escapeHtml(greeting.userName)}</h2>
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

function renderSuggestedPrompts(prompts: SuggestedPrompt[]): string {
  const cardsHtml = prompts.map(p =>
    `<button class="prompt-card" data-prompt="${escapeHtml(p.prompt)}">
      <span class="prompt-card-label">${escapeHtml(p.label)}</span>
    </button>`
  ).join('');

  return `
    <div class="addie-home-prompts">
      <div class="prompt-grid">${cardsHtml}</div>
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
 * CSS styles for Addie Home — chat-first welcome screen
 */
export const ADDIE_HOME_CSS = `
.addie-home {
  max-width: 520px;
  margin: 0 auto;
  padding: 0 24px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* Greeting — minimal */
.addie-home-greeting {
  text-align: center;
  padding: var(--space-8) 0 var(--space-4);
}

.addie-home-greeting h2 {
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--color-text-heading);
  margin: 0 0 var(--space-1) 0;
}

.addie-home-status {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.addie-home-status.status-member {
  color: var(--color-success-600);
}

/* Alerts — compact */
.addie-home-alerts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  width: 100%;
}

.addie-home-alert {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  font-size: var(--text-sm);
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
  margin-bottom: 2px;
}

.addie-home-alert-content p {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin: 0;
}

.addie-home-alert-action {
  padding: var(--space-1) var(--space-3);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  cursor: pointer;
  text-decoration: none;
  color: var(--color-text);
  white-space: nowrap;
}

.addie-home-alert-action:hover {
  background: var(--color-bg-subtle);
}

/* Prompt cards — the hero */
.addie-home-prompts {
  width: 100%;
  padding: var(--space-2) 0 var(--space-6);
}

.prompt-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.prompt-card {
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.prompt-card:hover {
  border-color: var(--color-brand);
  background: var(--color-bg-subtle);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.prompt-card-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.4;
}

.prompt-card:hover .prompt-card-label {
  color: var(--color-brand);
}

/* Single column on narrow screens */
@media (max-width: 480px) {
  .prompt-grid {
    grid-template-columns: 1fr;
  }
}
`;
