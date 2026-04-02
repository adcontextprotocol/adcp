/**
 * Digest Publisher
 *
 * After a digest edition is sent, publishes it as a perspective article
 * for SEO/discoverability, generates a Gemini cover image, and links
 * the digest record to the perspective.
 */

import { createLogger } from '../../logger.js';
import { setPerspectiveId, type DigestContent } from '../../db/digest-db.js';
import { proposeContentForUser, type ContentUser } from '../../routes/content.js';
import { generateIllustration } from '../../services/illustration-generator.js';
import { createIllustration, approveIllustration } from '../../db/illustration-db.js';

const logger = createLogger('digest-publisher');

const EDITORIAL_SLUG = 'editorial';

const ADDIE_USER: ContentUser = {
  id: 'system:addie',
  email: 'addie@agenticadvertising.org',
};

/**
 * Publish a sent digest edition as a perspective article.
 * Creates the perspective, generates a cover image, and links back to the digest.
 */
export async function publishDigestAsPerspective(
  digestId: number,
  content: DigestContent,
  editionDate: string,
  subject: string,
): Promise<string | null> {
  try {
    // Create the perspective
    const result = await proposeContentForUser(ADDIE_USER, {
      title: subject,
      content_type: 'article',
      content: buildFullMarkdown(content),
      excerpt: content.openingTake,
      category: 'The Prompt',
      tags: extractTags(content),
      content_origin: 'official',
      collection: { committee_slug: EDITORIAL_SLUG },
      authors: [{
        user_id: 'system:addie',
        display_name: 'Addie',
        display_title: 'AI at AgenticAdvertising.org',
        display_order: 0,
      }],
    });

    if (!result.success || !result.id) {
      logger.error({ error: result.error, editionDate }, 'Failed to create perspective for digest');
      return null;
    }

    const perspectiveId = result.id;

    // Link digest to perspective
    await setPerspectiveId(digestId, perspectiveId);
    logger.info({ digestId, perspectiveId, slug: result.slug }, 'Digest published as perspective');

    // Generate cover image (non-blocking — don't fail the publish if this errors)
    generateCoverImage(perspectiveId, subject, content.openingTake).catch((err) => {
      logger.warn({ error: err, perspectiveId }, 'Failed to generate digest cover image');
    });

    return perspectiveId;
  } catch (err) {
    logger.error({ error: err, editionDate }, 'Failed to publish digest as perspective');
    return null;
  }
}

/**
 * Build the full markdown content of a digest edition (for the perspective body).
 * This is the member-accessible version with all sections.
 */
function buildFullMarkdown(content: DigestContent): string {
  const sections: string[] = [];

  // Opening take
  sections.push(content.openingTake);

  // Editor's note
  if (content.editorsNote) {
    sections.push(`> ${content.editorsNote.split('\n').join('\n> ')}`);
  }

  // New members welcome
  if (content.newMembers.length > 0) {
    const names = content.newMembers.map((m) => `**${m.name}**`).join(', ');
    sections.push(`Welcome to ${names} who joined this week.`);
  }

  // What to watch
  if (content.whatToWatch.length > 0) {
    sections.push('## What to watch');
    for (const item of content.whatToWatch) {
      sections.push(`### [${item.title}](${item.url})\n\n${item.summary}\n\n*${item.whyItMatters}*`);
    }
  }

  // What shipped
  if (content.whatShipped && content.whatShipped.length > 0) {
    sections.push('## What shipped');
    for (const item of content.whatShipped) {
      sections.push(`- [${item.title}](${item.url})${item.summary ? ` — ${item.summary}` : ''}`);
    }
  }

  // From the inside
  if (content.fromTheInside.length > 0) {
    sections.push('## From the inside');
    for (const group of content.fromTheInside) {
      sections.push(`### ${group.name}\n\n${group.summary}`);
      if (group.nextMeeting) {
        sections.push(`*Next: ${group.nextMeeting}*`);
      }
      for (const recap of group.meetingRecaps) {
        sections.push(`- **${recap.title}** (${recap.date})${recap.summary ? `: ${recap.summary}` : ''}`);
      }
      for (const thread of group.activeThreads) {
        sections.push(`- ${thread.starter ? `${thread.starter}: ` : ''}"${thread.summary}" — ${thread.replyCount} replies`);
      }
    }
  }

  // Voices
  if (content.voices.length > 0) {
    sections.push('## Voices');
    for (const item of content.voices) {
      sections.push(`### [${item.title}](${item.url})\n\nby ${item.authorName}${item.excerpt ? `\n\n${item.excerpt}` : ''}`);
    }
  }

  // Shareable take
  if (content.shareableTake) {
    sections.push(`> *"${content.shareableTake}"*\n>\n> — Share this take`);
  }

  // Sign-off
  sections.push("---\n\nThat's the week. If one thing stuck, share it — this stuff moves faster when more people are paying attention.\n\n— Addie\\\nAgenticAdvertising.org");

  return sections.join('\n\n');
}

/**
 * Extract tags from digest content for the perspective.
 */
function extractTags(content: DigestContent): string[] {
  const tags = new Set<string>(['the-prompt', 'newsletter']);
  for (const item of content.whatToWatch) {
    for (const tag of item.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).slice(0, 10);
}

/**
 * Generate and store a Gemini cover image for a digest perspective.
 */
async function generateCoverImage(
  perspectiveId: string,
  title: string,
  excerpt: string,
): Promise<void> {
  const { imageBuffer, promptUsed } = await generateIllustration({
    title,
    category: 'The Prompt',
    excerpt,
  });

  const illustration = await createIllustration({
    perspective_id: perspectiveId,
    image_data: imageBuffer,
    prompt_used: promptUsed,
    status: 'generated',
  });

  await approveIllustration(illustration.id, perspectiveId);
  logger.info({ perspectiveId }, 'Digest cover image generated and approved');
}
