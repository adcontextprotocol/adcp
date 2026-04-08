/**
 * The Prompt — Addie's Weekly Newsletter
 *
 * Registers The Prompt with the shared newsletter infrastructure.
 * All content-specific logic delegates to existing digest modules.
 */

import type { NewsletterConfig } from '../config.js';
import { registerNewsletter } from '../registry.js';
import { buildDigestContent, hasMinimumContent, generateDigestSubject } from '../../addie/services/digest-builder.js';
import { renderDigestEmail, renderDigestSlack, renderDigestReview } from '../../addie/templates/weekly-digest.js';
import {
  createDigest,
  getDigestByDate,
  getCurrentWeekDigest,
  approveDigest,
  updateDigestContent,
  markSent,
  setReviewMessage,
  getDigestByReviewMessage,
  setPerspectiveId,
  getRecentDigests,
  getDigestEmailRecipients,
  getUserWorkingGroupMap,
  type DigestContent,
  type DigestRecord,
} from '../../db/digest-db.js';
import type { EditionRecord, NewsletterEditionDB, SendStats, NewsletterRecipient } from '../config.js';

// ─── Palette ───────────────────────────────────────────────────────────

const PROMPT_PALETTE = {
  primary: '#2563eb',
  light: '#f0f4ff',
  dark: '#1a1a2e',
};

// ─── Illustration ──────────────────────────────────────────────────────

const PROMPT_ILLUSTRATION_STYLE = `Create a purely visual illustration — NO TEXT OF ANY KIND.
CRITICAL: Do not render any words, letters, titles, labels, captions, watermarks, numbers, or logos. The image must contain zero text.
Landscape aspect ratio (1200x630, roughly 1.9:1).

STYLE: Flat illustration, graphic novel style with clean minimal linework and subtle gradients. NOT painterly or photorealistic — think modern editorial illustration for a tech publication.
COLOR PALETTE: Blue-led (#1a36b4 primary, #2d4fd6 secondary, #6b8cef light accents) with warm amber highlights (#D4A017, #F4C430). Deep navy backgrounds (#0f172a, #1e293b). High contrast, limited palette.

CHARACTERS — pick 1-2 from this recurring cast to feature in the scene:
- Alex Reeves: Black woman, early 40s, locs pulled back, tortoiseshell reading glasses on head, structured blazer. Media operations leader.
- Sam Adeyemi: Nigerian-British man, early 30s, dark skin, close-cropped hair with sharp fade, clean-shaven, silver watch, rolled-up sleeves. Media buyer.
- Maya Johal: British-Indian woman, late 20s, long dark hair in loose braid, bold patterned scarf, chunky rings. Creative strategist.
- Priya Nair: Indian-American woman, late 30s, dark brown skin, short asymmetric black bob, rectangular dark-framed glasses. Ad products director.
- Dayo Mensah: Ghanaian-American, early-to-mid 20s, dark skin, short natural hair, bright expression, messenger bag. Ad tech fellow.
- Addie: Sleek blue rounded robot with expressive face and AgenticAdvertising.org emblem. The newsletter's author.

Show characters in a SPECIFIC scene related to the article topic — at a desk with screens, in a meeting room, reviewing data, discussing strategy.
Vary composition: sometimes a close-up of one character studying a screen, sometimes two characters in conversation, sometimes a wide shot of a workspace.`;

const PROMPT_CAST = [
  'Alex Reeves (Black woman, locs, blazer)',
  'Sam Adeyemi (Nigerian-British man, sharp fade, rolled sleeves)',
  'Maya Johal (British-Indian woman, braided hair, patterned scarf)',
  'Priya Nair (Indian-American woman, asymmetric bob, dark glasses)',
  'Dayo Mensah (Ghanaian-American, short natural hair, messenger bag)',
  'Addie (sleek blue robot with expressive face)',
];

// ─── DB Adapter ────────────────────────────────────────────────────────

function toEditionRecord(r: DigestRecord): EditionRecord {
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

const promptDB: NewsletterEditionDB = {
  async createEdition(editionDate, content) {
    const r = await createDigest(editionDate, content as DigestContent);
    return r ? toEditionRecord(r) : null;
  },
  async getByDate(editionDate) {
    const r = await getDigestByDate(editionDate);
    return r ? toEditionRecord(r) : null;
  },
  async getCurrent() {
    const r = await getCurrentWeekDigest();
    return r ? toEditionRecord(r) : null;
  },
  async approve(id, approvedBy) {
    const r = await approveDigest(id, approvedBy);
    return r ? toEditionRecord(r) : null;
  },
  async updateContent(id, content) {
    const r = await updateDigestContent(id, content as DigestContent);
    return r ? toEditionRecord(r) : null;
  },
  async markSent(id, stats) {
    return markSent(id, stats as Parameters<typeof markSent>[1]);
  },
  async setReviewMessage(id, channelId, messageTs) {
    await setReviewMessage(id, channelId, messageTs);
  },
  async getByReviewMessage(channelId, messageTs) {
    const r = await getDigestByReviewMessage(channelId, messageTs);
    return r ? toEditionRecord(r) : null;
  },
  async setPerspectiveId(id, perspectiveId) {
    await setPerspectiveId(id, perspectiveId);
  },
  async getRecent(limit) {
    const rows = await getRecentDigests(limit);
    return rows.map(toEditionRecord);
  },
  async getRecipients() {
    return getDigestEmailRecipients();
  },
  async getUserWorkingGroupMap() {
    return getUserWorkingGroupMap();
  },
};

// ─── Markdown builder ──────────────────────────────────────────────────

function buildPromptMarkdown(content: unknown): string {
  const c = content as DigestContent;
  const sections: string[] = [];

  sections.push(c.openingTake);
  if (c.editorsNote) sections.push(`> ${c.editorsNote.split('\n').join('\n> ')}`);
  if (c.newMembers.length > 0) {
    sections.push(`Welcome to ${c.newMembers.map((m) => `**${m.name}**`).join(', ')} who joined this week.`);
  }
  if (c.whatToWatch.length > 0) {
    const official = c.whatToWatch.filter((item) => item.tags?.includes('official'));
    const external = c.whatToWatch.filter((item) => !item.tags?.includes('official'));
    for (const item of official) {
      let block = `### [${item.title}](${item.url})\n\n${item.summary}`;
      if (item.takeaways && item.takeaways.length > 0) {
        block += '\n\n' + item.takeaways.map((tw) => `- ${tw}`).join('\n');
      }
      sections.push(block);
    }
    if (external.length > 0) {
      sections.push('## Industry intel');
      for (const item of external) {
        sections.push(`### [${item.title}](${item.url})\n\n${item.summary}\n\n*${item.whyItMatters}*`);
      }
    }
  }
  if (c.whatShipped && c.whatShipped.length > 0) {
    sections.push('## What shipped');
    for (const item of c.whatShipped) {
      sections.push(`- [${item.title}](${item.url})${item.summary ? ` — ${item.summary}` : ''}`);
    }
  }
  if (c.fromTheInside.length > 0) {
    sections.push('## From the inside');
    for (const group of c.fromTheInside) {
      sections.push(`### ${group.name}\n\n${group.summary}`);
      if (group.nextMeeting) sections.push(`*Next: ${group.nextMeeting}*`);
      for (const recap of group.meetingRecaps) {
        sections.push(`- **${recap.title}** (${recap.date})${recap.summary ? `: ${recap.summary}` : ''}`);
      }
      for (const thread of group.activeThreads) {
        sections.push(`- ${thread.starter ? `${thread.starter}: ` : ''}"${thread.summary}" — ${thread.replyCount} replies`);
      }
    }
  }
  if (c.voices.length > 0) {
    sections.push('## Voices');
    for (const item of c.voices) {
      sections.push(`### [${item.title}](${item.url})\n\nby ${item.authorName}${item.excerpt ? `\n\n${item.excerpt}` : ''}`);
    }
  }
  if (c.shareableTake) {
    sections.push(`> *"${c.shareableTake}"*\n>\n> — Share this take`);
  }
  if (c.takeActions && c.takeActions.length > 0) {
    sections.push('## Take action');
    for (const action of c.takeActions) {
      sections.push(`- **[${action.ctaLabel}](${action.ctaUrl})** — ${action.text}`);
    }
  }
  sections.push("---\n\nWe're building this together. If something here resonated, pass it along — every share brings in someone new.\n\nLet's keep building,\nAddie\\\nAgenticAdvertising.org");
  return sections.join('\n\n');
}

function extractPromptTags(content: unknown): string[] {
  const c = content as DigestContent;
  const tags = new Set<string>(['the-prompt', 'newsletter']);
  for (const item of c.whatToWatch) {
    for (const tag of item.tags) tags.add(tag);
  }
  return Array.from(tags).slice(0, 10);
}

// ─── Registration ──────────────────────────────────────────────────────

export const thePromptConfig: NewsletterConfig = {
  id: 'the_prompt',
  name: 'The Prompt',
  author: 'Addie',
  authorTitle: 'AI at AgenticAdvertising.org',
  authorSystemId: 'system:addie',
  emailCategory: 'weekly_digest',
  fromEmail: 'Addie from AgenticAdvertising.org <addie@updates.agenticadvertising.org>',
  palette: PROMPT_PALETTE,
  cadence: {
    generateHourET: 7,
    sendHourET: 9,
    shouldRunToday: (dateOverride?: Date) => {
      const now = dateOverride || new Date();
      const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (et.getDay() !== 2) return false; // Tuesday only

      // Biweekly: count weeks from a known send-day Tuesday
      const epoch = new Date(2026, 0, 6); // 2026-01-06, a Tuesday
      const diffWeeks = Math.round((et.getTime() - epoch.getTime()) / (7 * 86400000));
      return diffWeeks % 2 === 0;
    },
  },
  perspectiveSlugPrefix: 'the-prompt',
  perspectiveCategory: 'The Prompt',
  illustrationStylePrompt: PROMPT_ILLUSTRATION_STYLE,
  illustrationCast: PROMPT_CAST,
  signOff: {
    text: "We're building this together. If something here resonated, pass it along — every share brings in someone new.",
    attribution: 'Addie',
    domain: 'AgenticAdvertising.org',
  },
  announcementChannelEnvVar: 'SLACK_ANNOUNCEMENTS_CHANNEL',
  buildContent: buildDigestContent,
  hasMinimumContent: (c) => hasMinimumContent(c as DigestContent),
  generateSubject: (c) => generateDigestSubject(c as DigestContent),
  buildMarkdown: buildPromptMarkdown,
  extractTags: extractPromptTags,
  renderEmail: (content, trackingId, editionDate, segment, firstName, userWGs, personaCluster, recipient) =>
    renderDigestEmail(content as DigestContent, trackingId, editionDate, segment as Parameters<typeof renderDigestEmail>[3], firstName, userWGs, personaCluster as Parameters<typeof renderDigestEmail>[6], recipient as Parameters<typeof renderDigestEmail>[7]),
  renderSlack: (content, editionDate) => renderDigestSlack(content as DigestContent, editionDate),
  renderReview: (content, editionDate) => renderDigestReview(content as DigestContent, editionDate),
  db: promptDB,
  editableFields: ['openingTake', 'editorsNote', 'shareableTake', 'emailSubject'],
};

registerNewsletter(thePromptConfig);
