/**
 * The Prompt — Addie's Weekly Newsletter
 *
 * Registers The Prompt with the shared newsletter infrastructure.
 * All content-specific logic delegates to existing digest modules.
 */

import type { NewsletterConfig, SectionDescriptor, ItemOperations } from '../config.js';
import DOMPurify from 'isomorphic-dompurify';
import { registerNewsletter } from '../registry.js';
import { escapeHtml } from '../email-layout.js';
import { buildDigestContent, hasMinimumContent, generateDigestSubject } from '../../addie/services/digest-builder.js';
import { applyDigestEdit } from '../../addie/services/digest-editor.js';
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
  setDigestCoverImage,
  getDigestCoverImage,
  getDigestCoverImageWithPrompt,
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
  async setCoverImage(id, imageData, promptUsed) {
    return setDigestCoverImage(id, imageData, promptUsed);
  },
  async getCoverImage(editionDate) {
    return getDigestCoverImage(editionDate);
  },
  async getCoverImageWithPrompt(editionDate) {
    return getDigestCoverImageWithPrompt(editionDate);
  },
};

// ─── Markdown builder ──────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  const dom = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'a', 'strong', 'em', 'li'],
    ALLOWED_ATTR: ['href'],
    RETURN_DOM: true,
  }) as unknown as DocumentFragment;
  return domToMarkdown(dom).replace(/\n{3,}/g, '\n\n').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSDOM node from DOMPurify RETURN_DOM
function domToMarkdown(node: any): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node;
  const tag = el.tagName?.toLowerCase();
  const inner = Array.from(el.childNodes).map(domToMarkdown).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'p': return inner + '\n\n';
    case 'strong': return `**${inner}**`;
    case 'em': return `_${inner}_`;
    case 'a': { const href = el.getAttribute('href'); return href ? `[${inner}](${href})` : inner; }
    case 'li': return `- ${inner}\n`;
    default: return inner;
  }
}

function buildPromptMarkdown(content: unknown): string {
  const c = content as DigestContent;
  const sections: string[] = [];

  if (c.coverImageUrl) {
    sections.push(`![The Prompt cover](${c.coverImageUrl})`);
  }
  sections.push(c.openingTake);
  if (c.editorsNote) {
    const noteText = /<(?:p|div|br|strong|em|ul|ol|li|a\s)[>\s\/]/i.test(c.editorsNote)
      ? htmlToMarkdown(c.editorsNote)
      : c.editorsNote;
    sections.push(`> ${noteText.split('\n').join('\n> ')}`);
  }
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
  if (c.specInsight) {
    sections.push(`## Something worth thinking about\n\n**${c.specInsight.title}**\n\n${c.specInsight.body}${c.specInsight.relatedSpecSections.length > 0 ? `\n\n*Related: ${c.specInsight.relatedSpecSections.join(', ')}*` : ''}`);
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

// ─── Section Descriptors ──────────────────────────────────────────────

function escUrl(s: string): string {
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

const PROMPT_SECTIONS: SectionDescriptor[] = [
  {
    key: 'whatToWatch',
    label: 'What to Watch',
    hint: 'Articles, official content, and industry intel',
    supportsItemEdit: true,
    countFn: (c) => (c as DigestContent).whatToWatch?.length ?? 0,
    renderHtml: (c) => {
      const items = (c as DigestContent).whatToWatch || [];
      if (items.length === 0) return '<em style="color:#888;">No articles this cycle</em>';
      return items.map((item, i) => {
        const isOfficial = item.tags?.includes('official');
        return `<div class="item-card" data-index="${i}">
          ${isOfficial ? '<span class="item-badge badge-official">OFFICIAL</span>' : ''}
          <a href="${escUrl(item.url)}" target="_blank"><strong>${escapeHtml(item.title)}</strong></a>
          <br><span style="font-size:13px;color:#666;">${escapeHtml(item.summary)}</span>
          ${item.whyItMatters ? `<br><em style="font-size:13px;color:#555;">${escapeHtml(item.whyItMatters)}</em>` : ''}
        </div>`;
      }).join('');
    },
  },
  {
    key: 'fromTheInside',
    label: 'From the Inside',
    hint: 'Working group activity, meetings, and active threads',
    countFn: (c) => (c as DigestContent).fromTheInside?.length ?? 0,
    renderHtml: (c) => {
      const groups = (c as DigestContent).fromTheInside || [];
      if (groups.length === 0) return '<em style="color:#888;">No WG activity this cycle</em>';
      return groups.map(g => `<div style="margin-bottom:12px;">
        <strong>${escapeHtml(g.name)}</strong>
        <br><span style="font-size:13px;color:#666;">${escapeHtml(g.summary)}</span>
        ${g.meetingRecaps.length > 0 ? `<br><span style="font-size:12px;color:#888;">${g.meetingRecaps.length} recap(s)</span>` : ''}
        ${g.activeThreads.length > 0 ? `<span style="font-size:12px;color:#888;margin-left:8px;">${g.activeThreads.length} thread(s)</span>` : ''}
      </div>`).join('');
    },
  },
  {
    key: 'specInsight',
    label: 'Spec Insight',
    hint: 'A protocol question worth thinking about',
    renderHtml: (c) => {
      const si = (c as DigestContent).specInsight;
      if (!si) return '<em style="color:#888;">No spec insight this edition</em>';
      return `<div style="background:#f0f4ff;border-left:3px solid #2563eb;padding:12px;border-radius:4px;">
        <strong>${escapeHtml(si.title)}</strong>
        <br><span style="font-size:13px;color:#666;">${escapeHtml(si.body.slice(0, 250))}${si.body.length > 250 ? '...' : ''}</span>
      </div>`;
    },
  },
  {
    key: 'voices',
    label: 'Voices',
    hint: 'Member perspectives and community contributions',
    countFn: (c) => (c as DigestContent).voices?.length ?? 0,
    renderHtml: (c) => {
      const voices = (c as DigestContent).voices || [];
      if (voices.length === 0) return '<em style="color:#888;">No perspectives this cycle</em>';
      return voices.map(v => `<div style="margin-bottom:8px;">
        <a href="${escUrl(v.url)}" target="_blank"><strong>${escapeHtml(v.title)}</strong></a>
        <br><span style="font-size:13px;color:#666;">by ${escapeHtml(v.authorName)}</span>
      </div>`).join('');
    },
  },
  {
    key: 'newMembers',
    label: 'New Members',
    hint: 'Organizations that joined recently',
    layout: 'half',
    countFn: (c) => (c as DigestContent).newMembers?.length ?? 0,
    renderHtml: (c) => {
      const members = (c as DigestContent).newMembers || [];
      if (members.length === 0) return '<em style="color:#888;">No new members</em>';
      return members.map(m => `<span style="margin-right:8px;">${escapeHtml(m.name)}</span>`).join('');
    },
  },
  {
    key: 'whatShipped',
    label: 'What Shipped',
    hint: 'Recent releases and changelog entries',
    layout: 'half',
    countFn: (c) => (c as DigestContent).whatShipped?.length ?? 0,
    renderHtml: (c) => {
      const shipped = (c as DigestContent).whatShipped || [];
      if (shipped.length === 0) return '<em style="color:#888;">No releases</em>';
      return shipped.map(s => `<div style="margin-bottom:6px;">
        <a href="${escUrl(s.url)}" target="_blank">${escapeHtml(s.title)}</a>
        ${s.summary ? ` — <span style="font-size:13px;color:#666;">${escapeHtml(s.summary)}</span>` : ''}
      </div>`).join('');
    },
  },
];

// ─── Item Operations (whatToWatch article CRUD) ───────────────────────

const PROMPT_ITEM_OPS: Record<string, ItemOperations> = {
  whatToWatch: {
    editItem: (content, index, body, editor) => {
      const c = { ...(content as DigestContent) };
      if (index < 0 || index >= c.whatToWatch.length) throw new Error('Index out of range');
      const article = { ...c.whatToWatch[index] };
      if (body.title !== undefined) article.title = String(body.title);
      if (body.summary !== undefined) article.summary = String(body.summary);
      if (body.whyItMatters !== undefined) article.whyItMatters = String(body.whyItMatters);
      if (body.url !== undefined) article.url = String(body.url);
      c.whatToWatch = [...c.whatToWatch];
      c.whatToWatch[index] = article;
      c.editHistory = [...(c.editHistory || []), {
        editedBy: editor,
        editedAt: new Date().toISOString(),
        description: `Edited article "${article.title.slice(0, 40)}"`,
      }];
      return c;
    },
    deleteItem: (content, index, editor) => {
      const c = { ...(content as DigestContent) };
      if (index < 0 || index >= c.whatToWatch.length) throw new Error('Index out of range');
      const removed = c.whatToWatch[index];
      c.whatToWatch = c.whatToWatch.filter((_, i) => i !== index);
      c.editHistory = [...(c.editHistory || []), {
        editedBy: editor,
        editedAt: new Date().toISOString(),
        description: `Removed article "${removed.title.slice(0, 40)}"`,
      }];
      return c;
    },
    reorderItems: (content, indices, editor) => {
      const c = { ...(content as DigestContent) };
      if (indices.length !== c.whatToWatch.length) throw new Error('Index array length mismatch');
      const original = [...c.whatToWatch];
      c.whatToWatch = indices.map(i => {
        if (i < 0 || i >= original.length) throw new Error('Invalid index in reorder');
        return original[i];
      });
      c.editHistory = [...(c.editHistory || []), {
        editedBy: editor,
        editedAt: new Date().toISOString(),
        description: 'Reordered articles',
      }];
      return c;
    },
  },
};

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
  coverRoutePrefix: '/digest',
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
  editableFields: ['openingTake', 'editorsNote', 'shareableTake', 'emailSubject', 'dateFlavor'],
  sections: PROMPT_SECTIONS,
  itemOperations: PROMPT_ITEM_OPS,
  applyInstruction: async (content, instruction, editorName) => {
    const result = await applyDigestEdit(content as DigestContent, instruction, editorName);
    return { content: result.content, summary: result.summary };
  },
  adminIcon: '/addie-icon.svg',
};

registerNewsletter(thePromptConfig);
