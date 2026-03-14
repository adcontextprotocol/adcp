/**
 * Report Generator — renders simulation results as static HTML timeline.
 *
 * One HTML page per simulation run, with:
 * - Timeline rail showing clock ticks
 * - Each person as a swim lane
 * - Messages as cards (Addie = blue, person = green, skip = gray)
 * - Decision annotations
 */

import type { SimulationReport, TimelineEvent } from './types.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const EVENT_COLORS: Record<string, string> = {
  outreach_decided: '#3b82f6',   // blue
  outreach_skipped: '#9ca3af',   // gray
  message_sent: '#2563eb',       // darker blue
  message_received: '#16a34a',   // green
  stage_changed: '#f59e0b',      // amber
  user_action: '#8b5cf6',        // purple
  compose_skipped: '#d1d5db',    // light gray
  error: '#ef4444',              // red
};

const EVENT_LABELS: Record<string, string> = {
  outreach_decided: 'Decided to contact',
  outreach_skipped: 'Skipped',
  message_sent: 'Addie sent',
  message_received: 'Person sent',
  stage_changed: 'Stage changed',
  user_action: 'User action',
  compose_skipped: 'Sonnet skipped',
  error: 'Error',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function renderEventCard(event: TimelineEvent): string {
  const color = EVENT_COLORS[event.type] ?? '#6b7280';
  const label = EVENT_LABELS[event.type] ?? event.type;

  let detailsHtml = '';
  for (const [key, value] of Object.entries(event.details)) {
    if (value === null || value === undefined) continue;
    const displayValue = typeof value === 'string' ? escapeHtml(value) : JSON.stringify(value);
    detailsHtml += `<div class="detail"><span class="detail-key">${escapeHtml(key)}:</span> ${displayValue}</div>`;
  }

  return `
    <div class="event-card" style="border-left: 4px solid ${color}">
      <div class="event-header">
        <span class="event-type" style="color: ${color}">${escapeHtml(label)}</span>
        <span class="event-time">${formatDate(event.timestamp)}</span>
        ${event.channel ? `<span class="event-channel">${escapeHtml(event.channel)}</span>` : ''}
      </div>
      ${detailsHtml ? `<div class="event-details">${detailsHtml}</div>` : ''}
    </div>`;
}

function renderPersonLane(
  personId: string,
  profileInfo: { id: string; description: string; startStage: string; endStage: string },
  events: TimelineEvent[]
): string {
  const eventsHtml = events.map(renderEventCard).join('\n');

  return `
    <div class="person-lane">
      <div class="person-header">
        <h3>${escapeHtml(events[0]?.personName ?? profileInfo.id)}</h3>
        <div class="person-meta">
          <span class="archetype">${escapeHtml(profileInfo.description)}</span>
          <span class="stage-badge">${escapeHtml(profileInfo.startStage)} &rarr; ${escapeHtml(profileInfo.endStage)}</span>
          <span class="event-count">${events.length} events</span>
        </div>
      </div>
      <div class="events-list">
        ${eventsHtml}
      </div>
    </div>`;
}

export function renderSimulationReport(report: SimulationReport): string {
  const personLanes = report.profiles.map(profile => {
    const events = report.timeline.filter(e => e.personId === profile.personId);
    return renderPersonLane(profile.personId, profile, events);
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Addie simulation report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.5;
      color: #1f2937;
      background: #f9fafb;
      padding: 2rem;
    }
    .report-header {
      max-width: 1200px;
      margin: 0 auto 2rem;
      padding: 1.5rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .report-header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .stats {
      display: flex;
      gap: 2rem;
      margin-top: 1rem;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #2563eb; }
    .stat-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; }
    .person-lane {
      max-width: 1200px;
      margin: 0 auto 1.5rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .person-header {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
    }
    .person-header h3 { font-size: 1.1rem; }
    .person-meta {
      display: flex;
      gap: 1rem;
      margin-top: 0.25rem;
      font-size: 0.8rem;
      color: #6b7280;
    }
    .stage-badge {
      background: #fef3c7;
      color: #92400e;
      padding: 0 0.5rem;
      border-radius: 4px;
      font-weight: 500;
    }
    .events-list { padding: 1rem 1.5rem; }
    .event-card {
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      background: #f9fafb;
      border-radius: 4px;
    }
    .event-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.85rem;
    }
    .event-type { font-weight: 600; }
    .event-time { color: #9ca3af; font-size: 0.75rem; }
    .event-channel {
      background: #e0e7ff;
      color: #3730a3;
      padding: 0 0.4rem;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 500;
    }
    .event-details { margin-top: 0.5rem; font-size: 0.8rem; color: #4b5563; }
    .detail { margin-bottom: 0.15rem; }
    .detail-key { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="report-header">
    <h1>Addie simulation report</h1>
    <p>${formatDate(report.duration.start)} &mdash; ${formatDate(report.duration.end)} (${report.duration.simDays.toFixed(1)} simulated days)</p>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${report.profiles.length}</div>
        <div class="stat-label">People</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.outreachCycles}</div>
        <div class="stat-label">Outreach cycles</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.totalSent}</div>
        <div class="stat-label">Messages sent</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.totalSkipped}</div>
        <div class="stat-label">Skipped</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.timeline.length}</div>
        <div class="stat-label">Total events</div>
      </div>
    </div>
  </div>

  ${personLanes}
</body>
</html>`;
}

/**
 * Write the report to a file.
 */
export async function writeReport(report: SimulationReport, filename?: string): Promise<string> {
  const html = renderSimulationReport(report);
  const outputDir = join(import.meta.dirname, '..', 'reports');
  const { mkdirSync } = await import('fs');
  mkdirSync(outputDir, { recursive: true });

  const filepath = join(outputDir, filename ?? `sim-report-${Date.now()}.html`);
  await writeFile(filepath, html, 'utf-8');
  return filepath;
}
