/**
 * The Build — Sage's Biweekly Contributor Briefing
 *
 * Registers The Build with the shared newsletter infrastructure.
 */

import type { NewsletterConfig } from '../config.js';
import { registerNewsletter } from '../registry.js';
import { buildBuildContent, hasBuildMinimumContent, generateBuildSubject } from './builder.js';
import { renderBuildEmail, renderBuildSlack, renderBuildReview } from './template.js';
import {
  createBuildEdition,
  getBuildByDate,
  getCurrentBuildEdition,
  approveBuildEdition,
  updateBuildContent,
  markBuildSent,
  setBuildReviewMessage,
  getBuildByReviewMessage,
  setBuildPerspectiveId,
  getRecentBuildEditions,
  getBuildRecipients,
  type BuildContent,
  type BuildRecord,
} from '../../db/build-db.js';
import { getUserWorkingGroupMap } from '../../db/digest-db.js';
import type { EditionRecord, NewsletterEditionDB, SendStats, NewsletterRecipient } from '../config.js';

// ─── Palette ───────────────────────────────────────────────────────────

export const BUILD_PALETTE = {
  primary: '#0d9488',
  light: '#f0fdfa',
  dark: '#1a1a2e',
};

// ─── Illustration ──────────────────────────────────────────────────────

const BUILD_ILLUSTRATION_STYLE = `Create a purely visual illustration — NO TEXT OF ANY KIND.
CRITICAL: Do not render any words, letters, titles, labels, captions, watermarks, numbers, or logos. The image must contain zero text.
Landscape aspect ratio (1200x630, roughly 1.9:1).

STYLE: Flat illustration, graphic novel style with clean minimal linework and subtle gradients. NOT painterly or photorealistic — think modern editorial illustration for a developer publication.
COLOR PALETTE: Teal-led (#0d9488 primary, #14b8a6 secondary, #5eead4 light accents) with warm amber highlights (#D4A017, #F4C430). Deep slate backgrounds (#0f172a, #1e293b). High contrast, limited palette.

CHARACTERS — pick 1-2 from this recurring cast to feature in the scene:
- Alex Reeves: Black woman, early 40s, locs pulled back, tortoiseshell reading glasses, structured blazer. Media operations leader.
- Jordan Ochoa: Mexican-American woman, mid-30s, dark wavy hair, silver hoop earrings, fitted cardigan. Governance specialist.
- Priya Nair: Indian-American woman, late 30s, dark brown skin, short asymmetric black bob, rectangular dark-framed glasses. Ad products director.
- Kai Lindgren: Swedish man, early 30s, sandy blond hair, henley shirt, light puffer vest. Data partnerships.
- Dayo Mensah: Ghanaian-American, early-to-mid 20s, dark skin, short natural hair, bright expression, messenger bag. Ad tech fellow.
- Sage: Sleek teal rounded robot with expressive face. The protocol's voice and this newsletter's author.

Show characters in a SPECIFIC scene related to building and collaboration — reviewing architecture diagrams, pair-debugging on screens, whiteboard sessions, reviewing proposals, celebrating a merge. The scene should feel like a moment from a contributor's workday.
Vary composition: close-ups of code reviews, wide shots of collaborative spaces, two characters discussing a diagram.`;

const BUILD_CAST = [
  'Alex Reeves (Black woman, locs, blazer)',
  'Jordan Ochoa (Mexican-American woman, wavy hair, silver earrings)',
  'Priya Nair (Indian-American woman, asymmetric bob, dark glasses)',
  'Kai Lindgren (Swedish man, sandy blond, henley + puffer)',
  'Dayo Mensah (Ghanaian-American, short natural hair, messenger bag)',
  'Sage (sleek teal robot with expressive face)',
];

// ─── DB Adapter ────────────────────────────────────────────────────────

function toEditionRecord(r: BuildRecord): EditionRecord {
  return {
    id: r.id,
    edition_date: new Date(r.edition_date),
    status: r.status as EditionRecord['status'],
    content: r.content,
    approved_by: r.approved_by || null,
    approved_at: r.approved_at ? new Date(r.approved_at) : null,
    review_channel_id: r.review_channel_id || null,
    review_message_ts: r.review_message_ts || null,
    perspective_id: r.perspective_id || null,
    created_at: new Date(r.created_at),
    sent_at: r.sent_at ? new Date(r.sent_at) : null,
    send_stats: r.send_stats || null,
  };
}

const buildDB: NewsletterEditionDB = {
  async createEdition(editionDate, content) {
    const r = await createBuildEdition(editionDate, content as BuildContent);
    return r ? toEditionRecord(r) : null;
  },
  async getByDate(editionDate) {
    const r = await getBuildByDate(editionDate);
    return r ? toEditionRecord(r) : null;
  },
  async getCurrent() {
    const r = await getCurrentBuildEdition();
    return r ? toEditionRecord(r) : null;
  },
  async approve(id, approvedBy) {
    const r = await approveBuildEdition(id, approvedBy);
    return r ? toEditionRecord(r) : null;
  },
  async updateContent(id, content) {
    const r = await updateBuildContent(id, content as BuildContent);
    return r ? toEditionRecord(r) : null;
  },
  async markSent(id, stats) {
    return markBuildSent(id, stats);
  },
  async setReviewMessage(id, channelId, messageTs) {
    await setBuildReviewMessage(id, channelId, messageTs);
  },
  async getByReviewMessage(channelId, messageTs) {
    const r = await getBuildByReviewMessage(channelId, messageTs);
    return r ? toEditionRecord(r) : null;
  },
  async setPerspectiveId(id, perspectiveId) {
    await setBuildPerspectiveId(id, perspectiveId);
  },
  async getRecent(limit) {
    const rows = await getRecentBuildEditions(limit);
    return rows.map(toEditionRecord);
  },
  async getRecipients(): Promise<NewsletterRecipient[]> {
    return getBuildRecipients();
  },
  async getUserWorkingGroupMap() {
    return getUserWorkingGroupMap();
  },
};

// ─── Markdown builder ──────────────────────────────────────────────────

function buildMarkdown(content: unknown): string {
  const c = content as BuildContent;
  const sections: string[] = [];

  sections.push(c.statusLine);

  if (c.editorsNote) sections.push(`> ${c.editorsNote.split('\n').join('\n> ')}`);

  if (c.decisions.length > 0) {
    sections.push('## Decisions & proposals');
    for (const d of c.decisions) {
      const badge = d.status === 'decided' ? 'DECIDED' : d.status === 'open_for_comment' ? 'OPEN' : 'REVIEW';
      sections.push(`### [${badge}] ${d.workingGroup}: ${d.title}\n\n${d.summary}\n\n[View](${d.url})`);
    }
  }

  if (c.whatShipped.length > 0) {
    sections.push('## What shipped');
    for (const r of c.whatShipped) {
      sections.push(`- ${r.breaking ? '**BREAKING** ' : ''}[${r.repo} ${r.version}](${r.releaseUrl}) — ${r.summary}`);
    }
  }

  if (c.deepDive) {
    sections.push(`## Deep dive: ${c.deepDive.title}\n\n${c.deepDive.body}`);
  }

  if (c.helpNeeded.length > 0) {
    sections.push('## Help needed');
    for (const h of c.helpNeeded) {
      sections.push(`- **${h.source}**: [${h.title}](${h.url}) — ${h.context}`);
    }
  }

  if (c.contributorSpotlight.length > 0) {
    sections.push('## Contributor spotlight');
    for (const s of c.contributorSpotlight) {
      sections.push(`- **${s.name}**${s.handle ? ` (${s.handle})` : ''} — ${s.contribution}`);
    }
  }

  sections.push("---\n\nThat's the cycle. If something broke, file an issue. If something's missing, open a PR.\n\n— Sage\\\ndocs.adcontextprotocol.org");
  return sections.join('\n\n');
}

function extractTags(content: unknown): string[] {
  const c = content as BuildContent;
  const tags = new Set<string>(['the-build', 'newsletter', 'contributor']);
  for (const d of c.decisions) tags.add(d.workingGroup.toLowerCase().replace(/\s+/g, '-'));
  for (const r of c.whatShipped) tags.add(r.repo);
  return Array.from(tags).slice(0, 10);
}

// ─── Cadence ───────────────────────────────────────────────────────────

function isTriweeklyWednesday(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() !== 3) return false; // Wednesday only

  // Triweekly: count weeks from a known send-day Wednesday, send every 3rd week
  const epoch = new Date(2026, 0, 7); // 2026-01-07, a Wednesday
  const diffWeeks = Math.round((et.getTime() - epoch.getTime()) / (7 * 86400000));
  return diffWeeks % 3 === 0;
}

// ─── Registration ──────────────────────────────────────────────────────

export const theBuildConfig: NewsletterConfig = {
  id: 'the_build',
  name: 'The Build',
  author: 'Sage',
  authorTitle: 'AdCP Protocol',
  authorSystemId: 'system:sage',
  emailCategory: 'the_build',
  palette: BUILD_PALETTE,
  cadence: {
    generateHourET: 7,
    sendHourET: 9,
    shouldRunToday: isTriweeklyWednesday,
  },
  perspectiveSlugPrefix: 'the-build',
  perspectiveCategory: 'The Build',
  illustrationStylePrompt: BUILD_ILLUSTRATION_STYLE,
  illustrationCast: BUILD_CAST,
  signOff: {
    text: "That's the cycle. If something broke, file an issue. If something's missing, open a PR.",
    attribution: 'Sage',
    domain: 'docs.adcontextprotocol.org',
  },
  announcementChannelEnvVar: 'SLACK_BUILD_CHANNEL',
  buildContent: buildBuildContent,
  hasMinimumContent: (c) => hasBuildMinimumContent(c as BuildContent),
  generateSubject: (c) => generateBuildSubject(c as BuildContent),
  buildMarkdown,
  extractTags,
  renderEmail: (content, trackingId, editionDate, segment, firstName) =>
    renderBuildEmail(content as BuildContent, trackingId, editionDate, segment as Parameters<typeof renderBuildEmail>[3], firstName),
  renderSlack: (content, editionDate) => renderBuildSlack(content as BuildContent, editionDate),
  renderReview: (content, editionDate) => renderBuildReview(content as BuildContent, editionDate),
  db: buildDB,
  editableFields: ['statusLine', 'editorsNote', 'emailSubject'],
};

registerNewsletter(theBuildConfig);
